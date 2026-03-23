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

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/inference", tags=["Inference"])


# Track previous danger state per user (for "danger cleared" notifications)
_previous_danger_state = {}  # user_id → bool

def _is_user_paused(user_id: str) -> bool:
    """Check if user's active session is paused."""
    sessions = get_db()["sessions"]
    session = sessions.find_one({"user_id": user_id, "status": "active"})
    if not session:
        return False
    return session.get("paused", False)

def _get_active_session(user_id: str):
    """Find the active session for a user and increment frame count."""
    sessions = get_db()["sessions"]
    session = sessions.find_one({"user_id": user_id, "status": "active"})
    if session:
        sessions.update_one(
            {"session_id": session["session_id"]},
            {"$inc": {"frame_count": 1}}
        )
        return session["session_id"]
    return None


@router.post("/analyze_frame", response_model=AnalyzeFrameResponse)
async def analyze_frame(request: Request, file: UploadFile = File(...), current_user: dict = Depends(verify_token)):
    user_id = current_user["user_id"]
    start = tracker.start_timer()
    try:
        # 0. Check if user is paused
        if _is_user_paused(user_id):
            tracker.end_timer(start, success=True)
            return AnalyzeFrameResponse(
                status="paused",
                filename=file.filename,
                danger=False,
                alert_level="none",
                distance="Far",
                objects=[]
            )

        # 1. Receive image
        image_bytes = await file.read()
        logger.info(f"Received image: {file.filename} ({len(image_bytes)} bytes)")

        # 2. Decode and validate image
        img = decode_image(image_bytes)
        logger.info(f"Decoded image shape: {img.shape}")

        # 3. Prepare input based on model mode
        model = request.app.state.model
        if MODEL_MODE == "custom":
            model_input = process_image(image_bytes)
            logger.info(f"Preprocessed tensor shape: {model_input.shape}")
        else:
            model_input = img

        # 4. Run model inference → list of detections
        detections = run_inference(model, model_input)

        # 5. Motion tracking — enrich detections with movement data
        motion_tracker = get_motion_tracker(user_id)
        detections_with_motion = motion_tracker.update(detections)

        # 6. Get user's custom high risk classes
        settings = get_user_settings(user_id)
        user_classes = set(settings.get("high_risk_classes", []))
        sensitivity = settings.get("detection_sensitivity", "medium")

        # 7. Danger assessment logic with user's classes + motion + sensitivity
        image_height, image_width = img.shape[:2]
        result = assess_danger(
            detections_with_motion,
            high_risk_classes=user_classes,
            sensitivity=sensitivity,
            image_width=image_width,
            image_height=image_height
        )

        # 8. Link to active session and save to history
        session_id = _get_active_session(user_id)
        add_detection_record(user_id, result, session_id=session_id)

        # 9. Check if danger just cleared (was dangerous → now safe)
        was_danger = _previous_danger_state.get(user_id, False)
        is_danger = result["danger"]
        danger_cleared = was_danger and not is_danger
        _previous_danger_state[user_id] = is_danger

        clearance_message = None
        if danger_cleared:
            clearance_message = "Path Clear"
            logger.info(f"Danger cleared for user: {user_id}")

        # 10. Track success
        latency = tracker.end_timer(start, success=True)
        logger.info(f"Request completed in {latency:.1f}ms")

        # 11. Return structured response
        return AnalyzeFrameResponse(
            status="success",
            filename=file.filename,
            danger=is_danger,
            danger_cleared=danger_cleared,
            clearance_message=clearance_message,
            alert_level=result["alert_level"],
            distance=result["distance"],
            objects=result["objects"]
        )

    except ValueError as e:
        tracker.end_timer(start, success=False)
        logger.warning(f"Bad input: {e}")
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        tracker.end_timer(start, success=False)
        logger.error(f"Unexpected error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Internal server error")


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
    return {"status": "success", "detection": "active"}