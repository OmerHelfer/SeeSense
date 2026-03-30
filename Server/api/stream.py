from fastapi import APIRouter, Depends, WebSocket, WebSocketDisconnect
import json
import logging

from core.auth import verify_token
from core.config import MODEL_MODE
from services.vision_service import decode_image, process_image
from services.logic_service import assess_danger
from services.motion_tracker import get_tracker as get_motion_tracker, clear_tracker
from services.session_service import (
    get_or_create_session,
    stop_session,
    get_active_session,
    get_cached_state,
    update_cache,
    clear_cache,
    check_danger_cleared,
    save_frame_data_background,
)
from ml_engine.model_loader import run_inference
from api.settings import get_user_settings
from utils.metrics import tracker

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/stream", tags=["Stream"])


# ==================== Auth ====================

def _authenticate_ws(token: str) -> dict | None:
    """Verify JWT token for WebSocket connection (no Depends available)."""
    import jwt
    from core.config import JWT_SECRET_KEY, JWT_ALGORITHM
    from core.auth import is_blacklisted

    if is_blacklisted(token):
        return None

    try:
        payload = jwt.decode(token, JWT_SECRET_KEY, algorithms=[JWT_ALGORITHM])
        return {"user_id": payload["user_id"], "email": payload["email"]}
    except (jwt.ExpiredSignatureError, jwt.InvalidTokenError):
        return None


# ==================== Endpoints ====================

@router.get("/session_status")
async def session_status(current_user: dict = Depends(verify_token)):
    """Returns current session status — active/paused, frame count, duration."""
    user_id = current_user["user_id"]
    session = get_active_session(user_id)

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


# ==================== WebSocket ====================

@router.websocket("/ws")
async def websocket_stream(websocket: WebSocket, token: str = None):
    """
    Real-time video streaming via WebSocket.

    Connection: ws://host/stream/ws?token=JWT_TOKEN
    Client sends:
      - binary JPEG frames (for analysis)
      - text JSON { "type": "rtt_report", "rtt_ms": 48.5 } (latency reporting)
    Server responds: JSON detection results per frame
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
    session_id = get_or_create_session(user_id)

    # Load settings into cache once at connection (only DB call at connect time)
    settings = get_user_settings(user_id)
    update_cache(user_id, paused=False, session_id=session_id, settings=settings)

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
            # Receive either binary (frame) or text (rtt report) messages
            message = await websocket.receive()

            # ── Text message: RTT report from client ──
            if "text" in message:
                try:
                    data = json.loads(message["text"])
                    if data.get("type") == "rtt_report" and "rtt_ms" in data:
                        rtt = float(data["rtt_ms"])
                        if 0 < rtt < 30000:  # sanity check
                            tracker.record_client_rtt(rtt)
                except (json.JSONDecodeError, ValueError, TypeError):
                    pass  # ignore malformed text messages
                continue

            # ── Binary message: JPEG frame for analysis ──
            image_bytes = message.get("bytes")
            if not image_bytes:
                continue

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
                model_input = process_image(image_bytes) if MODEL_MODE == "custom" else img

                # Run inference + motion tracking
                detections = run_inference(model, model_input)
                motion_tracker = get_motion_tracker(user_id)
                detections_with_motion = motion_tracker.update(detections)

                # Danger assessment with user settings (from cache)
                user_settings = cached.get("settings", settings)
                result = assess_danger(
                    detections_with_motion,
                    high_risk_classes=set(user_settings.get("high_risk_classes", [])),
                    sensitivity=user_settings.get("detection_sensitivity", "medium"),
                    image_width=img.shape[1],
                    image_height=img.shape[0]
                )

                # Danger cleared check
                is_danger = result["danger"]
                danger_cleared = check_danger_cleared(user_id, is_danger)

                latency = tracker.end_timer(start, success=True)

                # ── Send result FIRST (fast) ──
                await websocket.send_json({
                    "type": "result",
                    "status": "success",
                    "frame": frame_count,
                    "latency_ms": round(latency, 1),
                    "danger": is_danger,
                    "danger_cleared": danger_cleared,
                    "clearance_message": "Path Clear" if danger_cleared else None,
                    "alert_level": result["alert_level"],
                    "distance": result["distance"],
                    "objects": result["objects"]
                })

                # ── DB writes AFTER response (background — non-blocking) ──
                save_frame_data_background(session_id, user_id, result, frame_count)

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
        # ── 4. Cleanup on disconnect ──
        clear_cache(user_id)
        clear_tracker(user_id)
        stop_session(session_id)