from fastapi import APIRouter, HTTPException, Depends, WebSocket, WebSocketDisconnect
from pydantic import BaseModel
import logging
import json
import uuid
from datetime import datetime, timedelta

from core.auth import verify_token
from core.config import MODEL_MODE
from core.database import get_db
from services.vision_service import decode_image, process_image
from services.logic_service import assess_danger
from services.motion_tracker import get_tracker as get_motion_tracker
from ml_engine.model_loader import run_inference
from api.settings import get_user_settings
from utils.metrics import tracker
from services.user_service import add_detection_record

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/stream", tags=["Stream"])

# Track previous danger state per user (for "danger cleared" via WS)
_ws_previous_danger_state = {}


class StopStreamRequest(BaseModel):
    session_id: str


class LiveFeedbackRequest(BaseModel):
    session_id: str


def _sessions():
    return get_db()["sessions"]


# ==================== DISABLED — Replaced by WebSocket (session opens/closes automatically) ====================
#
# @router.post("/start_stream")
# async def start_stream(current_user: dict = Depends(verify_token)):
#     """Initialize or resume a video streaming session."""
#     user_id = current_user["user_id"]
#     existing = _sessions().find_one({"user_id": user_id, "status": "active"})
#     if existing:
#         return {"status": "already_active", "session_id": existing["session_id"],
#                 "message": "Session already running"}
#     cutoff = (datetime.now() - timedelta(minutes=15)).isoformat()
#     recent = _sessions().find_one({"user_id": user_id, "status": "stopped",
#                                    "stopped_at": {"$gte": cutoff}})
#     if recent:
#         _sessions().update_one({"session_id": recent["session_id"]},
#                                {"$set": {"status": "active", "paused": False},
#                                 "$unset": {"stopped_at": ""}})
#         return {"status": "resumed", "session_id": recent["session_id"],
#                 "frame_count": recent["frame_count"], "message": "Previous session resumed"}
#     session_id = str(uuid.uuid4())
#     _sessions().insert_one({"session_id": session_id, "user_id": user_id,
#                             "status": "active", "started_at": datetime.now().isoformat(),
#                             "frame_count": 0})
#     return {"status": "success", "session_id": session_id, "message": "Stream session started"}
#
#
# @router.post("/stop_stream")
# async def stop_stream(request: StopStreamRequest, current_user: dict = Depends(verify_token)):
#     """Terminate an ongoing video analysis session."""
#     user_id = current_user["user_id"]
#     session = _sessions().find_one({"session_id": request.session_id, "user_id": user_id})
#     if not session:
#         raise HTTPException(status_code=404, detail="Session not found")
#     if session["status"] == "stopped":
#         raise HTTPException(status_code=400, detail="Session already stopped")
#     _sessions().update_one({"session_id": request.session_id},
#                            {"$set": {"status": "stopped",
#                                      "stopped_at": datetime.now().isoformat(), "paused": False}})
#     return {"status": "success", "session_id": request.session_id,
#             "frame_count": session["frame_count"], "message": "Stream session stopped"}
#
# ==================== END DISABLED ====================


@router.get("/session_status")
async def session_status(current_user: dict = Depends(verify_token)):
    """Returns current session status — active/paused, frame count, duration."""
    user_id = current_user["user_id"]
    session = _sessions().find_one({"user_id": user_id, "status": "active"})

    if not session:
        return {
            "status": "success",
            "session": None,
            "message": "No active session"
        }

    return {
        "status": "success",
        "session": {
            "session_id": session["session_id"],
            "started_at": session["started_at"],
            "frame_count": session["frame_count"],
            "paused": session.get("paused", False)
        }
    }


# ==================== WebSocket Streaming ====================

def _authenticate_ws(token: str) -> dict:
    """Verify JWT token for WebSocket connection (no Depends available)."""
    import jwt
    from core.config import JWT_SECRET_KEY, JWT_ALGORITHM
    from core.auth import blacklisted_tokens

    if token in blacklisted_tokens:
        return None

    try:
        payload = jwt.decode(token, JWT_SECRET_KEY, algorithms=[JWT_ALGORITHM])
        return {"user_id": payload["user_id"], "email": payload["email"]}
    except (jwt.ExpiredSignatureError, jwt.InvalidTokenError):
        return None


@router.websocket("/ws")
async def websocket_stream(websocket: WebSocket, token: str = None):
    """
    Real-time video streaming via WebSocket.

    Connection: ws://host/stream/ws?token=JWT_TOKEN
    Client sends: binary JPEG frames
    Server responds: JSON detection results per frame

    Flow:
    1. Client connects with JWT token as query param
    2. Server authenticates, creates/resumes session, sends confirmation
    3. Client sends binary image frames continuously
    4. Server processes each frame and sends back JSON result
    5. On disconnect — session is stopped automatically
    """
    # ── 1. Authenticate ──
    if not token:
        await websocket.close(code=4001, reason="Missing token. Connect with ?token=JWT")
        return

    user = _authenticate_ws(token)
    if not user:
        await websocket.close(code=4003, reason="Invalid or expired token")
        return

    user_id = user["user_id"]
    await websocket.accept()
    logger.info(f"WebSocket connected: user={user_id}")

    # ── 2. Create or resume session ──
    sessions = _sessions()
    existing = sessions.find_one({"user_id": user_id, "status": "active"})

    if existing:
        session_id = existing["session_id"]
    else:
        session_id = str(uuid.uuid4())
        sessions.insert_one({
            "session_id": session_id,
            "user_id": user_id,
            "status": "active",
            "started_at": datetime.now().isoformat(),
            "frame_count": 0
        })

    # Send connection confirmation
    await websocket.send_json({
        "type": "connected",
        "session_id": session_id,
        "message": "Stream session active"
    })

    # ── 3. Frame processing loop ──
    model = websocket.app.state.model
    frame_count = 0

    try:
        while True:
            # Receive binary frame from client
            image_bytes = await websocket.receive_bytes()
            start = tracker.start_timer()
            frame_count += 1

            try:
                # Check if paused
                session = sessions.find_one({"session_id": session_id})
                if session and session.get("paused", False):
                    await websocket.send_json({
                        "type": "result",
                        "status": "paused",
                        "frame": frame_count
                    })
                    tracker.end_timer(start, success=True)
                    continue

                # Increment frame count in DB
                sessions.update_one(
                    {"session_id": session_id},
                    {"$inc": {"frame_count": 1}}
                )

                # Decode and validate
                img = decode_image(image_bytes)

                # Prepare model input
                if MODEL_MODE == "custom":
                    model_input = process_image(image_bytes)
                else:
                    model_input = img

                # Run inference
                detections = run_inference(model, model_input)

                # Motion tracking
                motion_tracker = get_motion_tracker(user_id)
                detections_with_motion = motion_tracker.update(detections)

                # User settings
                settings = get_user_settings(user_id)
                user_classes = set(settings.get("high_risk_classes", []))
                sensitivity = settings.get("detection_sensitivity", "medium")

                # Danger assessment
                image_height, image_width = img.shape[:2]
                result = assess_danger(
                    detections_with_motion,
                    high_risk_classes=user_classes,
                    sensitivity=sensitivity,
                    image_width=image_width,
                    image_height=image_height
                )

                # Save to history
                add_detection_record(user_id, result, session_id=session_id)

                # Danger cleared check
                was_danger = _ws_previous_danger_state.get(user_id, False)
                is_danger = result["danger"]
                danger_cleared = was_danger and not is_danger
                _ws_previous_danger_state[user_id] = is_danger

                clearance_message = "Path Clear" if danger_cleared else None

                # Track latency
                latency = tracker.end_timer(start, success=True)

                # Send result back
                await websocket.send_json({
                    "type": "result",
                    "status": "success",
                    "frame": frame_count,
                    "latency_ms": round(latency, 1),
                    "danger": is_danger,
                    "danger_cleared": danger_cleared,
                    "clearance_message": clearance_message,
                    "alert_level": result["alert_level"],
                    "distance": result["distance"],
                    "objects": result["objects"]
                })

            except ValueError as e:
                tracker.end_timer(start, success=False)
                await websocket.send_json({
                    "type": "error",
                    "frame": frame_count,
                    "detail": str(e)
                })

            except Exception as e:
                tracker.end_timer(start, success=False)
                logger.error(f"WS frame error: {e}", exc_info=True)
                await websocket.send_json({
                    "type": "error",
                    "frame": frame_count,
                    "detail": "Internal processing error"
                })

    except WebSocketDisconnect:
        logger.info(f"WebSocket disconnected: user={user_id}, frames={frame_count}")

    except Exception as e:
        logger.error(f"WebSocket unexpected error: {e}", exc_info=True)

    finally:
        # ── 4. Cleanup: stop session on disconnect ──
        sessions.update_one(
            {"session_id": session_id, "status": "active"},
            {"$set": {"status": "stopped", "stopped_at": datetime.now().isoformat()}}
        )
        logger.info(f"Session stopped on disconnect: {session_id}")