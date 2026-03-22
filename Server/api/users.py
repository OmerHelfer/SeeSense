from fastapi import APIRouter, HTTPException, Depends
import logging
import random
import string
from datetime import datetime, timedelta

from schemas.user import (
    UserCreate,
    UserFeedback,
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
    add_feedback,
    trigger_emergency,
)
from services.email_service import (
    send_welcome_email,
    send_password_changed_email,
    send_password_reset_email,
    send_profile_updated_email,
    send_emergency_contact_email
)
from core.auth import create_token, verify_token, blacklisted_tokens

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/users", tags=["Users"])


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
        if profile.get("emergency_contact") and profile["emergency_contact"].get("email"):
            send_emergency_contact_email(
            profile["emergency_contact"]["email"],
            profile["emergency_contact"]["name"],
            profile["name"]
            )
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
    blacklisted_tokens.add(current_user["token"])
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

@router.get("/profile/{user_id}")
async def get_profile(user_id: str, current_user: dict = Depends(verify_token)):
    """Retrieve user profile. Requires authentication."""
    profile = get_user(user_id)
    if not profile:
        raise HTTPException(status_code=404, detail="User not found")
    return {"status": "success", "user": profile}


@router.post("/profile/{user_id}/update")
async def update_profile(user_id: str, updates: dict, current_user: dict = Depends(verify_token)):
    """Update user profile fields. Requires authentication."""
    if current_user["user_id"] != user_id:
        raise HTTPException(status_code=403, detail="Cannot update another user's profile")

    profile = update_user(user_id, updates)
    if not profile:
        raise HTTPException(status_code=404, detail="User not found")

    send_profile_updated_email(profile["email"], profile["name"], list(updates.keys()))
    return {"status": "success", "message": "Profile updated successfully", "user": profile}


# ==================== History & Feedback ====================

@router.get("/history/{user_id}")
async def user_history(user_id: str, limit: int = 50, current_user: dict = Depends(verify_token)):
    """Retrieve detection and alert history. Requires authentication."""
    history = get_user_history(user_id, limit)
    return {"status": "success", "user_id": user_id, "history": history}


@router.post("/feedback")
async def send_feedback(user_id: str, feedback: UserFeedback, current_user: dict = Depends(verify_token)):
    """Send user feedback on detection quality. Requires authentication."""
    profile = get_user(user_id)
    if not profile:
        raise HTTPException(status_code=404, detail="User not found")

    add_feedback(user_id, feedback.model_dump())
    return {"status": "success", "message": "Feedback received"}


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