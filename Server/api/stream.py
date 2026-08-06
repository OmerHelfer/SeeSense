from fastapi import APIRouter, Depends, WebSocket, WebSocketDisconnect
import json
import logging
import time
import asyncio
import threading

from core.auth import verify_token
from core.config import MODEL_MODE, TARGET_SIZE, MIN_INPUT_SIZE, MAX_INPUT_SIZE
from services.vision_service import decode_image, process_image
from services.logic_service import assess_danger
from services import db_writer
from services.motion_tracker import get_tracker as get_motion_tracker, clear_tracker
from services.session_service import (
    get_or_create_session,
    stop_session,
    get_active_session,
    get_cached_state,
    update_cache,
    clear_cache,
    evaluate_presence,
    has_new_alert,
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
    # Surfaced on the admin page: this is the size the client ACTUALLY negotiated,
    # which is the only way to tell a redeployed bundle from a cached one.
    tracker.record_input_size(frame_size)

    # ── 2. Create or resume session ──
    session_id = get_or_create_session(user_id)

    # Load settings into cache once at connection (only DB call at connect time)
    settings = get_user_settings(user_id)
    update_cache(user_id, paused=False, session_id=session_id, settings=settings)

    await websocket.send_json({
        "type": "connected",
        "session_id": session_id,
        # No frame-rate field: the client's MAX_INFLIGHT is the only thing that
        # governs the rate now. A cached older bundle simply finds no target_fps
        # and uses its own default, which is harmless — that path only ever set
        # a capture-poll rate it no longer has.
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

            # Raw receive() RETURNS the disconnect message — only the typed
            # helpers (receive_text/_bytes/_json) raise WebSocketDisconnect. Left
            # unhandled it fell through to `continue`, and the next receive() then
            # raised RuntimeError, so every normal disconnect was logged as an
            # "unexpected error" with a traceback and the clean branch below never ran.
            if message["type"] == "websocket.disconnect":
                raise WebSocketDisconnect(message.get("code", 1000))

            # ── Text message: RTT or FPS report from client ──
            if "text" in message:
                try:
                    data = json.loads(message["text"])
                    if data.get("type") == "rtt_report" and "rtt_ms" in data:
                        rtt = float(data["rtt_ms"])
                        if 0 < rtt < 30000:
                            tracker.record_client_rtt(rtt)
                            perf_history.record_rtt(rtt, user_id=user_id)
                        # Optional: the client's tiny /health ping. Carries almost no
                        # payload, so it measures the link's propagation floor and
                        # lets the frame RTT be split into an outbound and a return leg.
                        base = data.get("base_rtt_ms")
                        if base is not None:
                            base = float(base)
                            if 0 < base < 30000:
                                tracker.record_client_base_rtt(base)
                    elif data.get("type") == "fps_report" and "fps" in data:
                        fps = float(data["fps"])
                        if 0 < fps < 100:
                            tracker.record_client_fps(fps)
                    elif data.get("type") == "lost_report" and "lost" in data:
                        # Frames the client sent that never came back. Only the
                        # phone can know this — the server cannot count what never
                        # reached it. Sent as a delta, so just add it.
                        # Validated once here so both sinks get the same clamped
                        # value — this is untrusted client input.
                        lost = int(data["lost"])
                        if 0 < lost < 100000:
                            tracker.record_lost(lost)
                            perf_history.record_lost(lost, user_id=user_id)
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
            # Compressed size on the wire — the number the compression setting is
            # actually moving, and the denominator for "how long per KB uploaded".
            tracker.record_frame_bytes(len(image_bytes))

            start = tracker.start_timer()
            frame_count += 1
            # end_timer() is what increments the frame counters, so it must run
            # exactly once per frame. Without this flag a failure AFTER the
            # success call below (in practice: send_json on a socket the client
            # just closed) ran the handler's end_timer too, counting the same
            # frame as both a success and a failure and adding a bogus latency sample.
            counted = False

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
                    counted = True
                    continue

                # Per-stage timings (also persisted to perf_history via record_frame).
                # perf_counter throughout — the wall clock can be stepped by NTP and
                # is coarser; every value here is a difference, never a date.
                stage_times = {}

                # Decode and validate (letterbox to the connection's input size)
                t0 = time.perf_counter()
                img = decode_image(image_bytes, frame_size)
                stage_times["decode_quality"] = (time.perf_counter() - t0) * 1000
                tracker.record_stage("decode_quality", stage_times["decode_quality"])

                # Prepare model input
                # model_input = process_image(image_bytes) if MODEL_MODE == "custom" else img
                model_input = img

                # Run inference in a worker thread so the ~inference time doesn't
                # block the async event loop (which would stall /health pings and
                # make the connection watchdog falsely report "unstable").
                # NOTE: this measures dispatch + queueing + the forward pass. With
                # more than one user streaming it therefore includes the wait on
                # _inference_lock, which is real time the frame spends waiting but
                # is NOT the model getting slower.
                t1 = time.perf_counter()
                detections = await asyncio.to_thread(_run_inference_locked, model, model_input, frame_size)
                stage_times["inference"] = (time.perf_counter() - t1) * 1000
                tracker.record_stage("inference", stage_times["inference"])

                # Motion tracking
                t2 = time.perf_counter()
                motion_tracker = get_motion_tracker(user_id)
                detections_with_motion = motion_tracker.update(detections)
                stage_times["tracking"] = (time.perf_counter() - t2) * 1000
                tracker.record_stage("tracking", stage_times["tracking"])

                # Danger assessment with user settings (from cache)
                t3 = time.perf_counter()
                user_settings = cached.get("settings", settings)
                result = assess_danger(
                    detections_with_motion,
                    high_risk_classes=set(user_settings.get("high_risk_classes", [])),
                    sensitivity=user_settings.get("detection_sensitivity", "medium"),
                    image_width=img.shape[1],
                    image_height=img.shape[0]
                )
                # Clearance is decided by PRESENCE, not by alert level. An object
                # that stops moving drops to "none" while still standing in the
                # user's path, and announcing "נתיב פנוי" there is the single most
                # dangerous thing this app can say. See evaluate_presence.
                is_danger = result["danger"]
                presence = evaluate_presence(user_id, result["objects"])
                danger_cleared = presence["danger_cleared"]
                static_notice = presence["static_notice"]

                # Alert dedup — only True on a genuine none→low / low→high transition
                # per tracked object, so TTS/haptic don't fire every single frame for
                # the same still-present object (e.g. a car sitting at "low" for 10s).
                alert_is_new = has_new_alert(user_id, result["objects"])

                # The two calls above belong to this stage. They used to sit
                # AFTER it, inside the measured frame but in no stage at all, so
                # the breakdown quietly under-summed against the total.
                stage_times["danger_logic"] = (time.perf_counter() - t3) * 1000
                tracker.record_stage("danger_logic", stage_times["danger_logic"])

                # Amortised per-record cost measured by the batch writer. Unlike
                # every other row this is NOT this frame's own work — the writes
                # happen once a second on a background thread — so it is reported
                # for visibility but deliberately left out of the frame total.
                stage_times["db_write"] = db_writer.last_amortized_ms()
                tracker.record_stage("db_write", stage_times["db_write"])

                # ── Response: build the record + serialise + hand to the socket ──
                # Previously unmeasured and outside the frame timer entirely, which
                # meant JSON serialisation of every detection was silently charged
                # to "network" in the admin page's estimate.
                t4 = time.perf_counter()

                # Pre-generated id (no DB I/O on the hot path) so record_id can be
                # returned immediately; the insert is deferred to the batch writer.
                from services.user_service import build_detection_entry
                record_id, detection_entry = build_detection_entry(user_id, result, session_id=session_id)

                # Processing time as of this instant — it has to be read before the
                # payload is built, so it is the frame's cost up to the response and
                # not the final total the tracker records below.
                processing_ms = (t4 - start) * 1000

                await websocket.send_json({
                    "type": "result",
                    "status": "success",
                    "frame": frame_count,
                    "record_id": record_id,
                    "latency_ms": round(processing_ms, 1),
                    "danger": is_danger,
                    "danger_cleared": danger_cleared,
                    "clearance_message": "Path Clear" if danger_cleared else None,
                    # A watched object that is present and confirmed motionless.
                    # {class_name, position} — the client phrases it in Hebrew.
                    "static_notice": static_notice,
                    "alert_is_new": alert_is_new,
                    "alert_level": result["alert_level"],
                    "distance": result["distance"],
                    "objects": result["objects"]
                })

                stage_times["response"] = (time.perf_counter() - t4) * 1000
                tracker.record_stage("response", stage_times["response"])

                # Stopped here, after the send, so the frame total covers everything
                # the server does for that frame. A send that fails now falls to the
                # handler below and is counted once, as a failure.
                latency = tracker.end_timer(start, success=True)
                counted = True

                # ── Persist this frame's metrics to per-minute history ──
                perf_history.record_frame(latency, True, stage_times, user_id=user_id)

                # ── Hand both writes to the batch writer (after the response). ──
                # Previously each of these spawned its OWN thread every frame: 80
                # threads and 80 cross-country round trips per second at 40 FPS,
                # which starved the event loop and froze the client's overlay.
                # Buffered here and written once a second instead.
                db_writer.queue_detection(detection_entry)
                db_writer.note_frame_count(session_id, frame_count)

            except ValueError as e:
                # Quality reject: the frame arrived and was readable enough to
                # judge, and we decided against it (blur, exposure, covered lens,
                # too small). The world being difficult, not the server failing.
                if not counted:
                    perf_history.record_frame(
                        tracker.end_timer(start, success=False, outcome="reject"),
                        False, user_id=user_id, outcome="reject",
                    )
                # A rejected frame is not evidence that anything left — we simply
                # could not see. Feeding an empty list just withholds a refresh, so
                # tracks age out on _PRESENCE_TTL if the blur really does persist.
                danger_cleared = evaluate_presence(user_id, [])["danger_cleared"]
                await websocket.send_json({
                    "type": "error",
                    "frame": frame_count,
                    "detail": str(e),
                    "danger_cleared": danger_cleared,
                    "clearance_message": "Path Clear" if danger_cleared else None
                })

            except Exception as e:
                # Unexpected: a bug, or the send failing. Counted apart from
                # quality rejects because this one is ours to fix.
                if not counted:
                    perf_history.record_frame(
                        tracker.end_timer(start, success=False, outcome="error"),
                        False, user_id=user_id, outcome="error",
                    )
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