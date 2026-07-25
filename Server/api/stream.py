from fastapi import APIRouter, Depends, WebSocket, WebSocketDisconnect
import json
import logging
import time
import asyncio
import threading

from core.auth import verify_token
from core.config import MODEL_MODE, TARGET_FPS, TARGET_SIZE, MIN_INPUT_SIZE, MAX_INPUT_SIZE
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
    has_new_alert,
    save_frame_count_background,
)
from ml_engine.model_loader import run_inference
from api.settings import get_user_settings
from utils.metrics import tracker
from services import perf_history

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/stream", tags=["Stream"])

# Serializes model inference across concurrent connections. Ultralytics YOLO is
# not guaranteed thread-safe for concurrent forward passes, and the hardware can
# only do one at a time efficiently anyway — so we run inference in a worker
# thread (to keep the async event loop responsive to /health etc.) but hold this
# lock so only one inference actually executes at once.
_inference_lock = threading.Lock()


def _run_inference_locked(model, img_input, imgsz):
    with _inference_lock:
        return run_inference(model, img_input, imgsz=imgsz)


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
async def websocket_stream(websocket: WebSocket, token: str = None, input_size: int = None):
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
    from services.presence import mark_active
    mark_active(user_id)

    # Per-connection input size (client-requested, clamped to a safe range).
    # This is the square size used for both decode/letterbox and YOLO inference.
    try:
        frame_size = int(input_size) if input_size else TARGET_SIZE
    except (TypeError, ValueError):
        frame_size = TARGET_SIZE
    frame_size = max(MIN_INPUT_SIZE, min(MAX_INPUT_SIZE, frame_size))

    logger.info(f"WebSocket connected: user={user_id}, input_size={frame_size}")

    # ── 2. Create or resume session ──
    session_id = get_or_create_session(user_id)

    # Load settings into cache once at connection (only DB call at connect time)
    settings = get_user_settings(user_id)
    update_cache(user_id, paused=False, session_id=session_id, settings=settings)

    await websocket.send_json({
        "type": "connected",
        "session_id": session_id,
        "target_fps": TARGET_FPS,
        "input_size": frame_size,
        "message": "Stream session active"
    })

    # ── 3. Frame processing loop ──
    model = websocket.app.state.model
    frame_count = 0

    try:
        while True:
            # Receive either binary (frame) or text (rtt report) messages
            message = await websocket.receive()

            # ── Text message: RTT or FPS report from client ──
            if "text" in message:
                try:
                    data = json.loads(message["text"])
                    if data.get("type") == "rtt_report" and "rtt_ms" in data:
                        rtt = float(data["rtt_ms"])
                        if 0 < rtt < 30000:
                            tracker.record_client_rtt(rtt)
                            perf_history.record_rtt(rtt)
                    elif data.get("type") == "fps_report" and "fps" in data:
                        fps = float(data["fps"])
                        if 0 < fps < 100:
                            tracker.record_client_fps(fps)
                    elif data.get("type") == "client_stage_report" and isinstance(data.get("stages"), dict):
                        # Client-side per-stage timings (capture/encode/render/feedback).
                        tracker.record_client_stages(data["stages"])
                except (json.JSONDecodeError, ValueError, TypeError):
                    pass
                continue

            # ── Binary message: JPEG frame for analysis ──
            image_bytes = message.get("bytes")
            if not image_bytes:
                continue

            mark_active(user_id)  # scanning keeps the user "online"

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

                # Per-stage timings (also persisted to perf_history via record_frame)
                stage_times = {}

                # Decode and validate (letterbox to the connection's input size)
                t0 = time.time()
                img = decode_image(image_bytes, frame_size)
                stage_times["decode_quality"] = (time.time() - t0) * 1000
                tracker.record_stage("decode_quality", stage_times["decode_quality"])

                # Prepare model input
                # model_input = process_image(image_bytes) if MODEL_MODE == "custom" else img
                model_input = img

                # Run inference in a worker thread so the ~inference time doesn't
                # block the async event loop (which would stall /health pings and
                # make the connection watchdog falsely report "unstable").
                t1 = time.time()
                detections = await asyncio.to_thread(_run_inference_locked, model, model_input, frame_size)
                stage_times["inference"] = (time.time() - t1) * 1000
                tracker.record_stage("inference", stage_times["inference"])

                # Motion tracking
                t2 = time.time()
                motion_tracker = get_motion_tracker(user_id)
                detections_with_motion = motion_tracker.update(detections)
                stage_times["tracking"] = (time.time() - t2) * 1000
                tracker.record_stage("tracking", stage_times["tracking"])

                # Danger assessment with user settings (from cache)
                t3 = time.time()
                user_settings = cached.get("settings", settings)
                result = assess_danger(
                    detections_with_motion,
                    high_risk_classes=set(user_settings.get("high_risk_classes", [])),
                    sensitivity=user_settings.get("detection_sensitivity", "medium"),
                    image_width=img.shape[1],
                    image_height=img.shape[0]
                )
                stage_times["danger_logic"] = (time.time() - t3) * 1000
                tracker.record_stage("danger_logic", stage_times["danger_logic"])

                # Danger cleared check
                is_danger = result["danger"]
                danger_cleared = check_danger_cleared(user_id, is_danger)

                # Alert dedup — only True on a genuine none→low / low→high transition
                # per tracked object, so TTS/haptic don't fire every single frame for
                # the same still-present object (e.g. a car sitting at "low" for 10s).
                alert_is_new = has_new_alert(user_id, result["objects"])

                latency = tracker.end_timer(start, success=True)

                # ── Build the detection record with a pre-generated id (no DB I/O
                #    on the hot path) so we can return record_id immediately. The
                #    actual insert is deferred to a background thread below. ──
                t4 = time.time()
                from services.user_service import build_detection_entry, insert_detection_entry
                record_id, detection_entry = build_detection_entry(user_id, result, session_id=session_id)
                stage_times["db_write"] = (time.time() - t4) * 1000
                tracker.record_stage("db_write", stage_times["db_write"])

                # ── Persist this frame's metrics to per-minute history ──
                perf_history.record_frame(latency, True, stage_times)

                # ── Send result with record_id ──
                await websocket.send_json({
                    "type": "result",
                    "status": "success",
                    "frame": frame_count,
                    "record_id": record_id,
                    "latency_ms": round(latency, 1),
                    "danger": is_danger,
                    "danger_cleared": danger_cleared,
                    "clearance_message": "Path Clear" if danger_cleared else None,
                    "alert_is_new": alert_is_new,
                    "alert_level": result["alert_level"],
                    "distance": result["distance"],
                    "objects": result["objects"]
                })

                # ── Persist the detection record off the hot path (after response).
                #    Daemon thread mirrors save_frame_count_background — no asyncio
                #    task to be GC'd, and a failed write can't crash the stream. ──
                threading.Thread(
                    target=insert_detection_entry,
                    args=(detection_entry,),
                    daemon=True,
                ).start()

                # ── Frame count update in background ──
                save_frame_count_background(session_id, frame_count)

            except ValueError as e:
                perf_history.record_frame(tracker.end_timer(start, success=False), False)
                # Even on bad frames, check if danger state changed (e.g. user moved away)
                danger_cleared = check_danger_cleared(user_id, False)
                await websocket.send_json({
                    "type": "error",
                    "frame": frame_count,
                    "detail": str(e),
                    "danger_cleared": danger_cleared,
                    "clearance_message": "Path Clear" if danger_cleared else None
                })

            except Exception as e:
                perf_history.record_frame(tracker.end_timer(start, success=False), False)
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