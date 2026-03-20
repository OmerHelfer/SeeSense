from fastapi import APIRouter, File, UploadFile, HTTPException, Request
import logging

from services.vision_service import process_image
from services.logic_service import assess_danger
from services.motion_tracker import get_tracker as get_motion_tracker
from ml_engine.model_loader import run_inference
from schemas.payload import AnalyzeFrameResponse
from core.config import HIGH_RISK_CLASSES, ALL_CLASSES
from api.settings import user_settings, DEFAULT_SETTINGS
from utils.metrics import tracker

logger = logging.getLogger(__name__)

router = APIRouter()

# Track paused users (in-memory for POC)
_paused_users = set()


@router.post("/analyze_frame", response_model=AnalyzeFrameResponse)
async def analyze_frame(request: Request, file: UploadFile = File(...), user_id: str = "default"):
    start = tracker.start_timer()
    try:
        # 0. Check if user is paused
        if user_id in _paused_users:
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

        # 2. Preprocess → tensor (1, 3, 640, 640)
        img_tensor = process_image(image_bytes)
        logger.info(f"Preprocessed tensor shape: {img_tensor.shape}")

        # 3. Run model inference → list of detections
        model = request.app.state.model
        detections = run_inference(model, img_tensor)

        # 4. Motion tracking — enrich detections with movement data
        motion_tracker = get_motion_tracker(user_id)
        detections_with_motion = motion_tracker.update(detections)

        # 5. Get user's custom high risk classes
        settings = user_settings.get(user_id, DEFAULT_SETTINGS)
        user_classes = set(settings.get("high_risk_classes", []))
        sensitivity = settings.get("detection_sensitivity", "medium")

        # 6. Danger assessment logic with user's classes + motion + sensitivity
        result = assess_danger(detections_with_motion, high_risk_classes=user_classes, sensitivity=sensitivity)

        # 7. Track success
        latency = tracker.end_timer(start, success=True)
        logger.info(f"Request completed in {latency:.1f}ms")

        # 8. Return structured response
        return AnalyzeFrameResponse(
            status="success",
            filename=file.filename,
            danger=result["danger"],
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
async def pause_detection(user_id: str):
    """Temporarily halt detection for battery or manual control reasons."""
    _paused_users.add(user_id)
    logger.info(f"Detection paused for user: {user_id}")
    return {"status": "success", "user_id": user_id, "detection": "paused"}


@router.post("/resume_detection")
async def resume_detection(user_id: str):
    """Resume paused detection activity."""
    _paused_users.discard(user_id)
    logger.info(f"Detection resumed for user: {user_id}")
    return {"status": "success", "user_id": user_id, "detection": "active"}