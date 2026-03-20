from fastapi import APIRouter, File, UploadFile, HTTPException, Request
import logging

from services.vision_service import process_image
from services.logic_service import assess_danger
from ml_engine.model_loader import run_inference
from schemas.payload import AnalyzeFrameResponse
from core.config import HIGH_RISK_CLASSES
from utils.metrics import tracker

logger = logging.getLogger(__name__)

router = APIRouter()

# Track paused users - In-memory storage for POC (replace with DB later)
_paused_users = set() 


@router.post("/analyze_frame", response_model=AnalyzeFrameResponse)
async def analyze_frame(request: Request, file: UploadFile = File(...)):
    start = tracker.start_timer()
    try:
        # 1. Receive image
        image_bytes = await file.read()
        logger.info(f"Received image: {file.filename} ({len(image_bytes)} bytes)")

        # 2. Preprocess → tensor (1, 3, 640, 640)
        img_tensor = process_image(image_bytes)
        logger.info(f"Preprocessed tensor shape: {img_tensor.shape}")

        # 3. Run model inference → list of detections
        model = request.app.state.model
        detections = run_inference(model, img_tensor)

        # 4. Danger assessment logic
        result = assess_danger(detections)

        # 5. Track success
        latency = tracker.end_timer(start, success=True)
        logger.info(f"Request completed in {latency:.1f}ms")

        # 6. Return structured response
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
        "classes": sorted(list(HIGH_RISK_CLASSES))
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