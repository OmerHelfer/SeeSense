from fastapi import APIRouter, HTTPException, Depends
import logging

from schemas.user import (
    UserCreate,
    UserFeedback,
    EmergencyAlertRequest,
)
from services.user_service import (
    create_user,
    get_user,
    update_user,
    authenticate_user,
    get_user_history,
    add_feedback,
    trigger_emergency,
)
from core.auth import create_token, verify_token

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/users", tags=["Users"])


@router.post("/register")
async def register(user: UserCreate):
    """Create a new user account. Returns profile + JWT token."""
    try:
        profile = create_user(user.model_dump())
        token = create_token(profile["user_id"], profile["email"])
        return {"status": "success", "user": profile, "token": token}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/login")
async def login(email: str, password: str):
    """Authenticate user. Returns profile + JWT token."""
    profile = authenticate_user(email, password)
    if not profile:
        raise HTTPException(status_code=401, detail="Invalid email or password")
    token = create_token(profile["user_id"], profile["email"])
    return {"status": "success", "user": profile, "token": token}


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
    # Users can only update their own profile
    if current_user["user_id"] != user_id:
        raise HTTPException(status_code=403, detail="Cannot update another user's profile")

    profile = update_user(user_id, updates)
    if not profile:
        raise HTTPException(status_code=404, detail="User not found")
    return {"status": "success", "user": profile}


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


@router.post("/emergency_alert")
async def emergency_alert(alert: EmergencyAlertRequest):
    """
    Send emergency signal with GPS location to preset contact.
    No authentication required — emergency must always work.
    """
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