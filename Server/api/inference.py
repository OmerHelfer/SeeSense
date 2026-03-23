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


@router.post("/analyze_frame", response_model=AnalyzeFrameResponse)
async def analyze_frame(request: Request, file: UploadFile = File(...), current_user: dict = Depends(verify_token)):
    start = tracker.start_timer()
    user_id = current_user["user_id"]
    try:
        # 0. Check if user has an active session
        sessions = get_db()["sessions"]
        session = sessions.find_one({"user_id": user_id, "status": "active"})
        if not session:
            tracker.end_timer(start, success=False)
            raise HTTPException(status_code=400, detail="No active session. Call start_stream first.")

        session_id = session["session_id"]

        # 1. Check if user is paused
        if session.get("paused", False):
            tracker.end_timer(start, success=True)
            return AnalyzeFrameResponse(
                status="paused",
                filename=file.filename,
                danger=False,
                alert_level="none",
                distance="Far",
                objects=[]
            )

        # 2. Increment frame count (only if not paused)
        sessions.update_one(
            {"session_id": session_id},
            {"$inc": {"frame_count": 1}}
        )

        # 3. Receive image
        image_bytes = await file.read()
        logger.info(f"Received image: {file.filename} ({len(image_bytes)} bytes)")

        # 4. Decode and validate image
        img = decode_image(image_bytes)
        logger.info(f"Decoded image shape: {img.shape}")

        # 5. Prepare input based on model mode
        model = request.app.state.model
        if MODEL_MODE == "custom":
            model_input = process_image(image_bytes)
            logger.info(f"Preprocessed tensor shape: {model_input.shape}")
        else:
            model_input = img

        # 6. Run model inference → list of detections
        detections = run_inference(model, model_input)

        # 7. Motion tracking — enrich detections with movement data
        motion_tracker = get_motion_tracker(user_id)
        detections_with_motion = motion_tracker.update(detections)

        # 8. Get user's custom high risk classes
        settings = get_user_settings(user_id)
        user_classes = set(settings.get("high_risk_classes", []))
        sensitivity = settings.get("detection_sensitivity", "medium")

        # 9. Danger assessment logic with user's classes + motion + sensitivity
        image_height, image_width = img.shape[:2]
        result = assess_danger(
            detections_with_motion,
            high_risk_classes=user_classes,
            sensitivity=sensitivity,
            image_width=image_width,
            image_height=image_height
        )

        # 10. Save to history (session_id already fetched above)
        add_detection_record(user_id, result, session_id=session_id)

        # 11. Check if danger just cleared (was dangerous → now safe)
        was_danger = _previous_danger_state.get(user_id, False)
        is_danger = result["danger"]
        danger_cleared = was_danger and not is_danger
        _previous_danger_state[user_id] = is_danger

        clearance_message = None
        if danger_cleared:
            clearance_message = "Path Clear"
            logger.info(f"Danger cleared for user: {user_id}")

        # 12. Track success
        latency = tracker.end_timer(start, success=True)
        logger.info(f"Request completed in {latency:.1f}ms")

        # 13. Return structured response
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
    except HTTPException:
        raise
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