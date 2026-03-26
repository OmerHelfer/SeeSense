from fastapi import APIRouter, HTTPException, Depends, WebSocket, WebSocketDisconnect
from pydantic import BaseModel
import logging
import json
import uuid
import threading
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

# ==================== In-Memory Cache ====================
# Caches session state and user settings per user to avoid DB calls every frame.
# Updated by pause/resume endpoints and settings changes.
# user_id → {"paused": bool, "settings": dict, "session_id": str}
_user_cache = {}


def get_cached_state(user_id: str) -> dict:
    """Get cached session state for a user."""
    return _user_cache.get(user_id, {})


def update_cache(user_id: str, **kwargs):
    """Update cache for a user. Called by pause/resume/settings endpoints."""
    if user_id not in _user_cache:
        _user_cache[user_id] = {}
    _user_cache[user_id].update(kwargs)


def clear_cache(user_id: str):
    """Clear cache when user disconnects."""
    _user_cache.pop(user_id, None)


def _db_write_background(func, *args, **kwargs):
    """Run a DB write in a background thread — doesn't block the response."""
    thread = threading.Thread(target=func, args=args, kwargs=kwargs, daemon=True)
    thread.start()


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
        # Check for recently stopped session (within 15 minutes)
        cutoff = (datetime.now() - timedelta(minutes=15)).isoformat()
        recent = sessions.find_one({
            "user_id": user_id,
            "status": "stopped",
            "stopped_at": {"$gte": cutoff}
        })

        if recent:
            # Resume the recent session
            session_id = recent["session_id"]
            sessions.update_one(
                {"session_id": session_id},
                {"$set": {"status": "active", "paused": False},
                 "$unset": {"stopped_at": ""}}
            )
            logger.info(f"WebSocket resumed session: {session_id}, user={user_id}")
        else:
            # Create new session
            session_id = str(uuid.uuid4())
            sessions.insert_one({
                "session_id": session_id,
                "user_id": user_id,
                "status": "active",
                "started_at": datetime.now().isoformat(),
                "frame_count": 0
            })
            logger.info(f"WebSocket new session: {session_id}, user={user_id}")

    # ── Load cache once at connection (only DB calls during connection) ──
    settings = get_user_settings(user_id)
    update_cache(user_id,
                 paused=False,
                 session_id=session_id,
                 settings=settings)

    # Send connection confirmation
    await websocket.send_json({
        "type": "connected",
        "session_id": session_id,
        "message": "Stream session active"
    })

    # ── 3. Frame processing loop (zero DB calls per frame) ──
    model = websocket.app.state.model
    frame_count = 0

    try:
        while True:
            # Receive binary frame from client
            image_bytes = await websocket.receive_bytes()
            start = tracker.start_timer()
            frame_count += 1

            try:
                # Check if paused (from cache — 0ms, not DB — 71ms)
                cached = get_cached_state(user_id)
                if cached.get("paused", False):
                    await websocket.send_json({
                        "type": "result",
                        "status": "paused",
                        "frame": frame_count
                    })
                    tracker.end_timer(start, success=True)
                    continue

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

                # User settings (from cache — 0ms, not DB — 71ms)
                user_settings = cached.get("settings", settings)
                user_classes = set(user_settings.get("high_risk_classes", []))
                sensitivity = user_settings.get("detection_sensitivity", "medium")

                # Danger assessment
                image_height, image_width = img.shape[:2]
                result = assess_danger(
                    detections_with_motion,
                    high_risk_classes=user_classes,
                    sensitivity=sensitivity,
                    image_width=image_width,
                    image_height=image_height
                )

                # Danger cleared check
                was_danger = _ws_previous_danger_state.get(user_id, False)
                is_danger = result["danger"]
                danger_cleared = was_danger and not is_danger
                _ws_previous_danger_state[user_id] = is_danger

                clearance_message = "Path Clear" if danger_cleared else None

                # Track latency
                latency = tracker.end_timer(start, success=True)

                # ── Send result FIRST (fast) ──
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

                # ── DB writes AFTER response (background thread — doesn't block) ──
                _db_write_background(
                    _save_frame_data, session_id, user_id, result, frame_count
                )

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
        # ── 4. Cleanup: stop session + clear cache on disconnect ──
        clear_cache(user_id)
        sessions.update_one(
            {"session_id": session_id, "status": "active"},
            {"$set": {"status": "stopped", "stopped_at": datetime.now().isoformat()}}
        )
        logger.info(f"Session stopped on disconnect: {session_id}")


def _save_frame_data(session_id: str, user_id: str, result: dict, frame_count: int):
    """Background DB writes — runs in a separate thread after response is sent."""
    try:
        sessions = _sessions()
        sessions.update_one(
            {"session_id": session_id},
            {"$set": {"frame_count": frame_count}}
        )
        add_detection_record(user_id, result, session_id=session_id)
    except Exception as e:
        logger.error(f"Background DB write failed: {e}")