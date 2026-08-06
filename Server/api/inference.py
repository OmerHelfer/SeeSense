from fastapi import APIRouter, HTTPException, Depends
import logging

from core.config import ALL_CLASSES
from core.auth import verify_token
from core.database import get_db
from services.session_service import update_cache


logger = logging.getLogger(__name__)

router = APIRouter(prefix="/inference", tags=["Inference"])

@router.get("/get_supported_objects")
async def get_supported_objects():
    """Lists all object classes the system can detect."""
    return {
        "status": "success",
        "classes": sorted(list(ALL_CLASSES))
    }


@router.post("/pause_detection")
async def pause_detection(current_user: dict = Depends(verify_token)):
    """Temporarily halt detection."""
    user_id = current_user["user_id"]
    sessions = get_db()["sessions"]
    result = sessions.update_one(
        {"user_id": user_id, "status": "active"},
        {"$set": {"paused": True}}
    )
    if result.matched_count == 0:
        raise HTTPException(status_code=400, detail="No active session")
    update_cache(user_id, paused=True)  # Update cache so WebSocket sees it instantly
    return {"status": "success", "detection": "paused"}


@router.post("/resume_detection")
async def resume_detection(current_user: dict = Depends(verify_token)):
    """Resume paused detection."""
    user_id = current_user["user_id"]
    sessions = get_db()["sessions"]
    result = sessions.update_one(
        {"user_id": user_id, "status": "active"},
        {"$set": {"paused": False}}
    )
    if result.matched_count == 0:
        raise HTTPException(status_code=400, detail="No active session")
    update_cache(user_id, paused=False)  # Update cache so WebSocket sees it instantly
    return {"status": "success", "detection": "active"}