from fastapi import APIRouter, HTTPException, Depends
import logging
import random
import string
from datetime import datetime, timedelta

from schemas.user import (
    UserCreate,
    QuickFeedback,
    FeedbackUpdate,
    FeedbackFromHistory,
    StandaloneFeedback,
    EmergencyAlertRequest,
    LoginRequest,
    ChangePasswordRequest,
    ResetPasswordRequest,
    ForgotPasswordRequest,
)
from services.user_service import (
    create_user,
    get_user,
    get_user_by_email,
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
    trigger_emergency,
)
from services.email_service import (
    send_welcome_email,
    send_password_changed_email,
    send_password_reset_email,
    send_profile_updated_email,
    send_emergency_contact_email,
)
from core.auth import create_token, verify_token, blacklisted_tokens

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/users", tags=["Users"])

# Blacklisted tokens (for logout)
_blacklisted_tokens = set()

# Password reset codes: email → {"code": str, "expires": datetime}
_reset_codes = {}


# ==================== Auth ====================

@router.post("/register")
async def register(user: UserCreate):
    """Create a new user account. Returns profile + JWT token."""
    try:
        profile = create_user(user.model_dump())
        token = create_token(profile["user_id"], profile["email"])
        send_welcome_email(profile["email"], profile["name"])
        return {"status": "success", "message": "Registered successfully", "user": profile, "token": token}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/login")
async def login(request: LoginRequest):
    """Authenticate user. Returns profile + JWT token."""
    profile = authenticate_user(request.email, request.password)
    if not profile:
        raise HTTPException(status_code=401, detail="Invalid email or password")
    token = create_token(profile["user_id"], profile["email"])
    return {"status": "success", "message": "Logged in successfully", "user": profile, "token": token}


@router.post("/logout")
async def logout(current_user: dict = Depends(verify_token)):
    """Logout — invalidates the current token."""
    return {"status": "success", "message": "Logged out successfully"}


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
    send_password_changed_email(profile["email"], profile["name"])
    return {"status": "success", "message": "Password changed successfully"}


@router.post("/forgot_password")
async def forgot_password(request: ForgotPasswordRequest):
    """Send password reset code to email. No auth required."""
    profile = get_user_by_email(request.email)
    if not profile:
        # Don't reveal if email exists or not (security)
        return {"status": "success", "message": "If this email is registered, a reset code has been sent"}

    # Generate 6-digit code
    code = ''.join(random.choices(string.digits, k=6))
    _reset_codes[request.email] = {
        "code": code,
        "expires": datetime.now() + timedelta(minutes=15)
    }

    send_password_reset_email(request.email, profile["name"], code)
    return {"status": "success", "message": "If this email is registered, a reset code has been sent"}


@router.post("/reset_password")
async def reset_password(request: ResetPasswordRequest):
    """Reset password using the code sent to email. No auth required."""
    if len(request.new_password) < 6:
        raise HTTPException(status_code=400, detail="Password must be at least 6 characters")

    reset_data = _reset_codes.get(request.email)
    if not reset_data:
        raise HTTPException(status_code=400, detail="No reset code found. Request a new one.")

    if datetime.now() > reset_data["expires"]:
        _reset_codes.pop(request.email, None)
        raise HTTPException(status_code=400, detail="Reset code expired. Request a new one.")

    if reset_data["code"] != request.code:
        raise HTTPException(status_code=400, detail="Invalid reset code")

    profile = get_user_by_email(request.email)
    if not profile:
        raise HTTPException(status_code=404, detail="User not found")

    change_password(profile["user_id"], None, request.new_password, force=True)
    _reset_codes.pop(request.email, None)

    send_password_changed_email(request.email, profile["name"])
    return {"status": "success", "message": "Password reset successfully"}


# ==================== Profile ====================

@router.get("/profile")
async def get_profile(current_user: dict = Depends(verify_token)):
    """Retrieve user profile. Requires authentication."""
    profile = get_user(current_user["user_id"])
    if not profile:
        raise HTTPException(status_code=404, detail="User not found")
    return {"status": "success", "user": profile}


@router.post("/profile/update")
async def update_profile(updates: dict, current_user: dict = Depends(verify_token)):
    """Update user profile fields. Requires authentication."""
    user_id = current_user["user_id"]

    old_profile = get_user(user_id)
    old_contact_email = None
    if old_profile and old_profile.get("emergency_contact"):
        old_contact_email = old_profile["emergency_contact"].get("email")

    profile = update_user(user_id, updates)
    if not profile:
        raise HTTPException(status_code=404, detail="User not found")

    send_profile_updated_email(profile["email"], profile["name"])

    new_contact_email = None
    if profile.get("emergency_contact"):
        new_contact_email = profile["emergency_contact"].get("email")

    if new_contact_email and new_contact_email != old_contact_email:
        send_emergency_contact_email(
            new_contact_email,
            profile["emergency_contact"]["name"],
            profile["name"]
        )

    return {"status": "success", "message": "Profile updated successfully", "user": profile}


# ==================== History ====================

@router.get("/history")
async def user_history(
    limit: int = 50,
    period: str = "all",
    current_user: dict = Depends(verify_token)
):
    """
    Retrieve detection history. Filter by period: today, week, month, half_year, all.
    """
    user_id = current_user["user_id"]
    history = get_user_history(user_id, limit, period)
    return {"status": "success", "user_id": user_id, "total_records": len(history), "period": period, "history": history}


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
    """
    Quick feedback during walk — user presses 'wrong detection' or 'missed obstacle'.
    No notes required. Goes to pending list for companion to review later.
    """
    user_id = current_user["user_id"]
    feedback_id = create_quick_feedback(user_id, feedback.feedback_type, feedback.record_id)
    return {"status": "success", "message": "Feedback recorded", "feedback_id": feedback_id}


@router.post("/feedback/from_history")
async def feedback_from_history(feedback: FeedbackFromHistory, current_user: dict = Depends(verify_token)):
    """
    Companion creates feedback from a specific history record.
    Can include notes immediately or leave empty for later.
    """
    user_id = current_user["user_id"]
    feedback_id = create_feedback_from_history(user_id, feedback.record_id, feedback.feedback_type, feedback.notes)
    return {"status": "success", "message": "Feedback recorded", "feedback_id": feedback_id}


@router.post("/feedback/standalone")
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
    Automatically marks as submitted.
    """
    result = update_feedback(current_user["user_id"], feedback_id, update.notes, update.feedback_type)
    if not result:
        raise HTTPException(status_code=404, detail="Feedback not found")
    return {"status": "success", "message": "Feedback updated and submitted", "feedback": result}


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


# ==================== Emergency ====================

@router.post("/emergency_alert")
async def emergency_alert(alert: EmergencyAlertRequest):
    """Send emergency signal with GPS location. No auth required — emergency must always work."""
    try:
        result = trigger_emergency(
            user_id=alert.user_id,
            gps_lat=alert.gps_lat,
            gps_lon=alert.gps_lon,
            message=alert.message
        )
        return {"status": "Alert Sent", "alert": result}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))