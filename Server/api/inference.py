from fastapi import APIRouter, File, UploadFile, HTTPException, Request, Depends
import logging

from services.vision_service import decode_image, process_image
from services.logic_service import assess_danger
from services.motion_tracker import get_tracker as get_motion_tracker
from ml_engine.model_loader import run_inference, MockModel
from schemas.payload import AnalyzeFrameResponse
from core.config import HIGH_RISK_CLASSES, ALL_CLASSES, MODEL_MODE
from core.auth import verify_token
from core.database import get_db
from api.settings import get_user_settings, DEFAULT_SETTINGS
from utils.metrics import tracker
from services.user_service import add_detection_record
from slowapi import Limiter
from slowapi.util import get_remote_address

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/inference", tags=["Inference"])


# Track previous danger state per user (for "danger cleared" notifications)
_previous_danger_state = {}  # user_id -> bool

limiter = Limiter(key_func=get_remote_address)


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
    from services.session_service import update_cache
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
    from services.session_service import update_cache
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