from fastapi import APIRouter, HTTPException, Depends
import logging
import random
import string
from datetime import datetime, timedelta
from slowapi import Limiter
from slowapi.util import get_remote_address
from starlette.requests import Request

from schemas.user import (
    UserCreate,
    UpdateProfileRequest,
    QuickFeedback,
    FeedbackUpdate,
    FeedbackFromHistory,
    StandaloneFeedback,
    EmergencyAlertRequest,
    LoginRequest,
    ChangePasswordRequest,
    ResetPasswordRequest,
    ForgotPasswordRequest,
    AddEmergencyContactRequest,
    VerifyEmergencyContactRequest,
    ResendContactCodeRequest,
    RemoveEmergencyContactRequest,
)
from services.user_service import (
    create_user,
    get_user,
    get_user_by_email,
    _norm_email,
    update_user,
    change_password,
    authenticate_user,
    get_user_history,
    delete_detection_record,
    clear_user_history,
    create_quick_feedback,
    create_feedback_from_history,
    create_standalone_feedback,
    get_pending_feedback,
    get_all_feedback,
    update_feedback,
    submit_feedback,
    delete_feedback,
    count_unseen_responses,
    mark_responses_seen,
    add_emergency_contact,
    verify_emergency_contact,
    resend_contact_code,
    remove_emergency_contact,
    get_emergency_contacts,
    trigger_emergency,
    get_emergency_alert_history,
    MAX_EMERGENCY_CONTACTS,
    delete_user_account,
)
from services.email_service import (
    send_welcome_email,
    send_password_changed_email,
    send_password_reset_email,
    send_profile_updated_email,
    send_emergency_contact_verification_email,
    send_emergency_contact_confirmed_email,
    send_emergency_contact_removed_email,
    send_contact_verified_notification,
    send_account_deleted_email,
    send_account_deleted_to_contact,
)
from core.auth import create_token, verify_token, blacklist_token
from core.config import VALID_PERIODS
logger = logging.getLogger(__name__)

router = APIRouter(prefix="/users", tags=["Users"])

limiter = Limiter(key_func=get_remote_address)


def _send_email_background(func, *args):
    """Send email in a background thread — doesn't block the response."""
    import threading
    threading.Thread(target=func, args=args, daemon=True).start()


def _reset_codes_col():
    from core.database import get_db
    return get_db()["reset_codes"]


# ==================== Auth ====================

@router.post("/register")
async def register(user: UserCreate):
    """Create a new user account. Returns profile + JWT token."""
    try:
        profile = create_user(user.model_dump())
        token = create_token(profile["user_id"], profile["email"])
        _send_email_background(send_welcome_email, profile["email"], profile["name"])
        return {"status": "success", "message": "Registered successfully", "user": profile, "token": token}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/login")
@limiter.limit("10/minute")
async def login(request: Request, login_data: LoginRequest):
    """Authenticate user. Returns profile + JWT token."""
    profile = authenticate_user(login_data.email, login_data.password)
    if not profile:
        raise HTTPException(status_code=401, detail="Invalid email or password")
    token = create_token(profile["user_id"], profile["email"])
    from services.user_service import touch_last_seen
    touch_last_seen(profile["user_id"])
    from services.presence import mark_active
    mark_active(profile["user_id"])
    return {"status": "success", "message": "Logged in successfully", "user": profile, "token": token}


@router.post("/heartbeat")
async def heartbeat(current_user: dict = Depends(verify_token)):
    """Lightweight presence ping — the client calls this periodically while the app
    is open so the user reads as 'online' even when not actively scanning.
    (verify_token already stamps presence.)"""
    return {"status": "ok"}


@router.post("/logout")
async def logout(current_user: dict = Depends(verify_token)):
    """Logout — invalidates the current token."""
    blacklist_token(current_user["token"])
    return {"status": "success", "message": "Logged out successfully"}

@router.delete("/account")
async def delete_account(current_user: dict = Depends(verify_token)):
    """Permanently delete your OWN account and all associated data.
    Admins cannot self-delete — a super admin must demote them first."""
    user_id = current_user["user_id"]
    profile = get_user(user_id)
    if not profile:
        raise HTTPException(status_code=404, detail="User not found")

    # Anyone may delete their own account — except the LAST super admin, which
    # would leave the system with no one able to manage it.
    from services.user_service import is_last_super_admin
    if is_last_super_admin(user_id):
        raise HTTPException(
            status_code=403,
            detail="You are the last super admin — assign another super admin before deleting your account.",
        )

    # Notify verified emergency contacts
    contacts = profile.get("emergency_contacts", [])
    for contact in contacts:
        if contact["status"] == "verified":
            _send_email_background(
                send_account_deleted_to_contact,
                contact["email"],
                contact["name"],
                profile["name"]
            )

    # Send confirmation to user
    _send_email_background(send_account_deleted_email, profile["email"], profile["name"])

    success = delete_user_account(user_id)
    if not success:
        raise HTTPException(status_code=404, detail="User not found")

    blacklist_token(current_user["token"])

    return {"status": "success", "message": "Account and all data permanently deleted"}

# ==================== Password Management ====================

@router.post("/change_password")
async def change_password_endpoint(
    request: ChangePasswordRequest,
    current_user: dict = Depends(verify_token)
):
    """Change password for authenticated user."""
    if len(request.new_password) < 6:
        raise HTTPException(status_code=400, detail="Password must be at least 6 characters")

    success = change_password(current_user["user_id"], request.old_password, request.new_password)
    if not success:
        raise HTTPException(status_code=400, detail="Current password is incorrect")

    profile = get_user(current_user["user_id"])
    _send_email_background(send_password_changed_email, profile["email"], profile["name"])
    return {"status": "success", "message": "Password changed successfully"}


@router.post("/forgot_password")
@limiter.limit("3/minute")
async def forgot_password(request: Request, req: ForgotPasswordRequest):
    """Send password reset code to email. No auth required."""
    profile = get_user_by_email(req.email)
    if not profile:
        # Don't reveal if email exists or not (security)
        return {"status": "success", "message": "If this email is registered, a reset code has been sent"}

    # Generate 6-digit code and store in MongoDB (TTL handles expiry).
    # Key reset codes by the canonical (lower-cased) email so lookup on
    # reset matches regardless of the casing the user typed.
    email = _norm_email(req.email)
    code = ''.join(random.choices(string.digits, k=6))
    _reset_codes_col().update_one(
        {"email": email},
        {"$set": {"code": code, "created_at": datetime.utcnow()}},
        upsert=True
    )

    _send_email_background(send_password_reset_email, email, profile["name"], code)
    return {"status": "success", "message": "If this email is registered, a reset code has been sent"}


@router.post("/reset_password")
async def reset_password(request: ResetPasswordRequest):
    """Reset password using the code sent to email. No auth required."""
    if len(request.new_password) < 6:
        raise HTTPException(status_code=400, detail="Password must be at least 6 characters")

    email = _norm_email(request.email)
    reset_data = _reset_codes_col().find_one({"email": email})
    if not reset_data:
        raise HTTPException(status_code=400, detail="No reset code found. Request a new one.")

    if reset_data["code"] != request.code:
        raise HTTPException(status_code=400, detail="Invalid reset code")

    profile = get_user_by_email(email)
    if not profile:
        raise HTTPException(status_code=404, detail="User not found")

    change_password(profile["user_id"], None, request.new_password, force=True)
    _reset_codes_col().delete_one({"email": email})

    _send_email_background(send_password_changed_email, email, profile["name"])
    return {"status": "success", "message": "Password reset successfully"}


# ==================== Profile ====================

@router.get("/profile")
async def get_profile(current_user: dict = Depends(verify_token)):
    """Retrieve user profile with emergency contacts summary."""
    profile = get_user(current_user["user_id"])
    if not profile:
        raise HTTPException(status_code=404, detail="User not found")

    # Add contacts summary
    contacts = profile.get("emergency_contacts", [])
    profile["contacts_summary"] = {
        "total": len(contacts),
        "verified": len([c for c in contacts if c["status"] == "verified"]),
        "pending": len([c for c in contacts if c["status"] == "pending"]),
        "max_allowed": MAX_EMERGENCY_CONTACTS
    }

    return {"status": "success", "user": profile}


@router.post("/profile/update")
async def update_profile(updates: UpdateProfileRequest, current_user: dict = Depends(verify_token)):
    """Update user profile fields. Requires authentication."""
    user_id = current_user["user_id"]
    profile = update_user(user_id, updates.model_dump(exclude_none=True))
    if not profile:
        raise HTTPException(status_code=404, detail="User not found")
    _send_email_background(send_profile_updated_email, profile["email"], profile["name"])
    return {"status": "success", "message": "Profile updated successfully", "user": profile}


# ==================== History ====================

@router.get("/history")
async def user_history(limit: int = 50, period: str = "all", session_id: str = None, current_user: dict = Depends(verify_token)):
    """Retrieve detection history. Filter by period and/or session_id."""
    if period not in VALID_PERIODS:
        raise HTTPException(status_code=400, detail=f"Invalid period. Choose from: {sorted(VALID_PERIODS)}")
    user_id = current_user["user_id"]
    history = get_user_history(user_id, limit, period, session_id)
    return {"status": "success", "user_id": user_id, "total_records": len(history), "period": period, "session_id": session_id, "history": history}


@router.delete("/history/{record_id}")
async def delete_history_record(record_id: str, current_user: dict = Depends(verify_token)):
    """Delete a single detection record by ID."""
    success = delete_detection_record(current_user["user_id"], record_id)
    if not success:
        raise HTTPException(status_code=404, detail="Record not found")
    return {"status": "success", "message": "Record deleted"}


@router.delete("/history")
async def clear_history(current_user: dict = Depends(verify_token)):
    """Delete all detection history for the user."""
    count = clear_user_history(current_user["user_id"])
    return {"status": "success", "message": f"Cleared {count} records"}


# ==================== Feedback ====================

@router.post("/feedback/quick")
async def quick_feedback(feedback: QuickFeedback, current_user: dict = Depends(verify_token)):
    """Quick feedback during walk."""
    try:
        user_id = current_user["user_id"]
        feedback_id = create_quick_feedback(user_id, feedback.feedback_type, feedback.record_id)
        return {"status": "success", "message": "Feedback recorded", "feedback_id": feedback_id}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/feedback/from_history")
async def feedback_from_history(feedback: FeedbackFromHistory, current_user: dict = Depends(verify_token)):
    """Companion creates feedback from a specific history record."""
    try:
        user_id = current_user["user_id"]
        feedback_id = create_feedback_from_history(user_id, feedback.record_id, feedback.feedback_type, feedback.notes)
        return {"status": "success", "message": "Feedback recorded", "feedback_id": feedback_id}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

@router.post("/feedback/general")
async def standalone_feedback(feedback: StandaloneFeedback, current_user: dict = Depends(verify_token)):
    """
    Standalone feedback — not linked to any specific detection.
    General report about system behavior.
    """
    user_id = current_user["user_id"]
    feedback_id = create_standalone_feedback(user_id, feedback.feedback_type, feedback.notes)
    return {"status": "success", "message": "Feedback recorded", "feedback_id": feedback_id}


@router.get("/feedback/pending")
async def get_pending(current_user: dict = Depends(verify_token)):
    """Get all pending feedback waiting for companion review."""
    user_id = current_user["user_id"]
    pending = get_pending_feedback(user_id)
    return {"status": "success", "total": len(pending), "feedback": pending}


@router.get("/feedback/all")
async def get_all(current_user: dict = Depends(verify_token)):
    """Get all feedback — pending and submitted."""
    user_id = current_user["user_id"]
    all_fb = get_all_feedback(user_id)
    return {"status": "success", "total": len(all_fb), "feedback": all_fb}


@router.post("/feedback/{feedback_id}/update")
async def update_feedback_endpoint(feedback_id: str, update: FeedbackUpdate, current_user: dict = Depends(verify_token)):
    """
    Companion adds notes to a pending feedback.
    Automatically marks as submitted. Blocked once an admin is handling it.
    """
    try:
        result = update_feedback(current_user["user_id"], feedback_id, update.notes, update.feedback_type)
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))
    if not result:
        raise HTTPException(status_code=404, detail="Feedback not found")
    return {"status": "success", "message": "Feedback updated and submitted", "feedback": result}


@router.get("/feedback/responses/unseen_count")
async def unseen_responses_count(current_user: dict = Depends(verify_token)):
    """How many resolved-feedback responses the user hasn't seen yet (badge count)."""
    return {"status": "success", "count": count_unseen_responses(current_user["user_id"])}


@router.post("/feedback/responses/seen")
async def mark_responses_seen_endpoint(current_user: dict = Depends(verify_token)):
    """Mark all of the user's team responses as seen (clears the notification badge)."""
    updated = mark_responses_seen(current_user["user_id"])
    return {"status": "success", "updated": updated}


@router.post("/feedback/{feedback_id}/submit")
async def submit_feedback_endpoint(feedback_id: str, current_user: dict = Depends(verify_token)):
    """Submit a pending feedback as-is without adding notes."""
    success = submit_feedback(current_user["user_id"], feedback_id)
    if not success:
        raise HTTPException(status_code=404, detail="Feedback not found or already submitted")
    return {"status": "success", "message": "Feedback submitted"}


@router.delete("/feedback/{feedback_id}")
async def delete_feedback_endpoint(feedback_id: str, current_user: dict = Depends(verify_token)):
    """Delete a feedback entry."""
    success = delete_feedback(current_user["user_id"], feedback_id)
    if not success:
        raise HTTPException(status_code=404, detail="Feedback not found")
    return {"status": "success", "message": "Feedback deleted"}


# ==================== Emergency Contacts ====================

@router.post("/contacts/add")
async def add_contact(request: AddEmergencyContactRequest, current_user: dict = Depends(verify_token)):
    """
    Add an emergency contact. Sends verification code to their email.
    Contact stays pending until they confirm with the code. Max 5 contacts.
    """
    try:
        user_id = current_user["user_id"]
        profile = get_user(user_id)
        result = add_emergency_contact(user_id, request.name, request.phone, request.email)

        # Send verification email with the code
        code = result.pop("_code")
        _send_email_background(
            send_emergency_contact_verification_email,
            request.email, request.name, profile["name"], code
        )

        return {"status": "success", "message": f"Verification code sent to {request.email}", "contact": result}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/contacts/verify")
async def verify_contact(request: VerifyEmergencyContactRequest, current_user: dict = Depends(verify_token)):
    """Verify emergency contact using the code they received via email."""
    try:
        user_id = current_user["user_id"]
        profile = get_user(user_id)
        contact = verify_emergency_contact(user_id, request.email, request.code)

        # Notify contact they are confirmed
        _send_email_background(send_emergency_contact_confirmed_email, request.email, contact["name"], profile["name"])
        _send_email_background(send_contact_verified_notification, profile["email"], profile["name"], contact["name"])

        return {"status": "success", "message": "Contact verified successfully", "contact": contact}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/contacts/resend_code")
async def resend_code(request: ResendContactCodeRequest, current_user: dict = Depends(verify_token)):
    """Resend verification code to a pending contact."""
    try:
        user_id = current_user["user_id"]
        profile = get_user(user_id)

        # Get contact name before resending
        contacts = get_emergency_contacts(user_id)
        contact_info = next((c for c in contacts if c["email"] == request.email), None)
        contact_name = contact_info["name"] if contact_info else ""

        code = resend_contact_code(user_id, request.email)

        _send_email_background(
            send_emergency_contact_verification_email,
            request.email, contact_name, profile["name"], code
        )

        return {"status": "success", "message": f"New verification code sent to {request.email}"}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.delete("/contacts/remove")
async def remove_contact(request: RemoveEmergencyContactRequest, current_user: dict = Depends(verify_token)):
    """Remove an emergency contact (pending or verified)."""
    user_id = current_user["user_id"]
    profile = get_user(user_id)

    # Get contact info before removing (for email notification)
    contacts = get_emergency_contacts(user_id)
    contact_info = next((c for c in contacts if c["email"] == request.email), None)

    success = remove_emergency_contact(user_id, request.email)
    if not success:
        raise HTTPException(status_code=404, detail="Contact not found")

    # Notify the removed contact if they were verified
    if contact_info and contact_info["status"] == "verified":
        _send_email_background(
            send_emergency_contact_removed_email,
            request.email, contact_info["name"], profile["name"]
        )

    return {"status": "success", "message": "Contact removed"}


@router.get("/contacts")
async def list_contacts(current_user: dict = Depends(verify_token)):
    """Get all emergency contacts with their status."""
    user_id = current_user["user_id"]
    contacts = get_emergency_contacts(user_id)
    return {
        "status": "success",
        "total": len(contacts),
        "max_allowed": 5,
        "contacts": contacts
    }


# ==================== Emergency Alert ====================

@router.post("/emergency_alert")
async def emergency_alert(alert: EmergencyAlertRequest, current_user: dict = Depends(verify_token)):
    """Send emergency signal with GPS location."""
    try:
        result = trigger_emergency(
            user_id=current_user["user_id"],
            gps_lat=alert.gps_lat,
            gps_lon=alert.gps_lon,
        )
        return {"status": "Alert Sent", "alert": result}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/emergency_alerts")
async def list_emergency_alerts(current_user: dict = Depends(verify_token)):
    """Get the user's SOS alert history (newest first, max 50)."""
    user_id = current_user["user_id"]
    alerts = get_emergency_alert_history(user_id)
    return {"status": "success", "alerts": alerts, "count": len(alerts)}