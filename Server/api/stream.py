from fastapi import APIRouter, Depends, WebSocket, WebSocketDisconnect
import json
import logging
import time
import asyncio
import threading

from core.auth import verify_token
from core.config import MODEL_MODE, TARGET_SIZE, MIN_INPUT_SIZE, MAX_INPUT_SIZE
from services.stream_config_service import get_stream_config
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

_inference_lock = threading.Lock()


def _run_inference_locked(model, img_input, imgsz):
    with _inference_lock:
        return run_inference(model, img_input, imgsz=imgsz)



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

    # Server's global config wins over the client's ?input_size= hint, which is
    # kept only as a fallback for a bundle that predates the admin config page.
    stream_cfg = get_stream_config()
    frame_size = stream_cfg.get("input_size")
    if not frame_size:
        try:
            frame_size = int(input_size) if input_size else TARGET_SIZE
        except (TypeError, ValueError):
            frame_size = TARGET_SIZE
    frame_size = max(MIN_INPUT_SIZE, min(MAX_INPUT_SIZE, frame_size))

    logger.info(
        f"WebSocket connected: user={user_id}, input_size={frame_size}, "
        f"compression={stream_cfg['compression_percent']}, depth={stream_cfg['max_inflight']}"
    )
    tracker.record_input_size(frame_size)
    tracker.record_stream_config(stream_cfg)

    session_id = get_or_create_session(user_id)

    settings = get_user_settings(user_id)
    update_cache(user_id, paused=False, session_id=session_id, settings=settings)

    await websocket.send_json({
        "type": "connected",
        "session_id": session_id,
        "input_size": frame_size,
        "compression_percent": stream_cfg["compression_percent"],
        "max_inflight": stream_cfg["max_inflight"],
        "message": "Stream session active"
    })

    model = websocket.app.state.model
    frame_count = 0

    # Arrival time (server clock) of an `upload_probe` marker awaiting its frame.
    # See the uplink-timing note below. None means no probe is outstanding.
    probe_at = None

    try:
        while True:
            message = await websocket.receive()

            if message["type"] == "websocket.disconnect":
                raise WebSocketDisconnect(message.get("code", 1000))

            if "text" in message:
                # Stamp arrival before any parsing, so the probe measures the wire
                # and not our own JSON handling.
                text_at = time.perf_counter()
                try:
                    data = json.loads(message["text"])
                    if data.get("type") == "upload_probe":
                        # A tiny marker the client sends immediately before a frame,
                        # on the same TCP connection. Both messages queue together,
                        # so the gap between their ARRIVALS — measured entirely on
                        # this server's clock, no client clock involved and therefore
                        # no clock-skew problem — is the time the frame's bytes took
                        # to cross the uplink bottleneck. That is the transmission
                        # term, the only part of the upload that payload size can
                        # move, which makes it the honest number to watch when
                        # changing JPEG compression or input size.
                        probe_at = text_at
                        continue
                    # Any other text message invalidates a pending probe: the gap
                    # would no longer be frame-only. Cannot normally happen (the
                    # client sends probe and frame back-to-back in one tick) but
                    # this is untrusted input and ordering must not be assumed.
                    probe_at = None
                    if data.get("type") == "rtt_report" and "rtt_ms" in data:
                        rtt = float(data["rtt_ms"])
                        if 0 < rtt < 30000:
                            tracker.record_client_rtt(rtt)
                            perf_history.record_rtt(rtt, user_id=user_id)
                        base = data.get("base_rtt_ms")
                        if base is not None:
                            base = float(base)
                            if 0 < base < 30000:
                                tracker.record_client_base_rtt(base)
                    elif data.get("type") == "e2e_report" and "e2e_ms" in data:
                        e2e = float(data["e2e_ms"])
                        if 0 < e2e < 60000:
                            e_min = data.get("e2e_min_ms")
                            e_max = data.get("e2e_max_ms")
                            e_min = float(e_min) if e_min is not None else None
                            e_max = float(e_max) if e_max is not None else None
                            if e_min is not None and not (0 < e_min < 60000):
                                e_min = None
                            if e_max is not None and not (0 < e_max < 60000):
                                e_max = None
                            tracker.record_client_e2e(e2e, e_min, e_max)
                            perf_history.record_e2e(e2e, user_id=user_id)
                    elif data.get("type") == "dl_wire_report" and "dl_ms" in data:
                        dl = float(data["dl_ms"])
                        if 0 <= dl < 5000:
                            tracker.record_download_wire(dl)
                    elif data.get("type") == "fps_report" and "fps" in data:
                        fps = float(data["fps"])
                        if 0 < fps < 100:
                            tracker.record_client_fps(fps)
                    elif data.get("type") == "lost_report" and "lost" in data:
                        lost = int(data["lost"])
                        if 0 < lost < 100000:
                            tracker.record_lost(lost)
                            perf_history.record_lost(lost, user_id=user_id)
                    elif data.get("type") == "client_stage_report" and isinstance(data.get("stages"), dict):
                        tracker.record_client_stages(data["stages"])
                except (json.JSONDecodeError, ValueError, TypeError):
                    pass
                continue

            image_bytes = message.get("bytes")
            if not image_bytes:
                continue

            # Close the uplink transmission measurement opened by the probe marker.
            # Clamped: a multi-second gap means the connection stalled or the client
            # paused between the two sends, which is not a bandwidth reading.
            probe_this_frame = False
            if probe_at is not None:
                wire_ms = (time.perf_counter() - probe_at) * 1000
                probe_at = None
                if 0 <= wire_ms < 5000:
                    tracker.record_upload_wire(wire_ms, len(image_bytes))
                    probe_this_frame = True

            mark_active(user_id)
            tracker.record_frame_bytes(len(image_bytes))

            start = tracker.start_timer()
            frame_count += 1
            counted = False

            try:
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

                stage_times = {}

                t0 = time.perf_counter()
                img = decode_image(image_bytes, frame_size)
                stage_times["decode_quality"] = (time.perf_counter() - t0) * 1000
                tracker.record_stage("decode_quality", stage_times["decode_quality"])

                model_input = img

                t1 = time.perf_counter()
                detections = await asyncio.to_thread(_run_inference_locked, model, model_input, frame_size)
                stage_times["inference"] = (time.perf_counter() - t1) * 1000
                tracker.record_stage("inference", stage_times["inference"])

                t2 = time.perf_counter()
                motion_tracker = get_motion_tracker(user_id)
                detections_with_motion = motion_tracker.update(detections)
                stage_times["tracking"] = (time.perf_counter() - t2) * 1000
                tracker.record_stage("tracking", stage_times["tracking"])

                t3 = time.perf_counter()
                user_settings = cached.get("settings", settings)
                result = assess_danger(
                    detections_with_motion,
                    high_risk_classes=set(user_settings.get("high_risk_classes", [])),
                    sensitivity=user_settings.get("detection_sensitivity", "medium"),
                    image_width=img.shape[1],
                    image_height=img.shape[0]
                )
                is_danger = result["danger"]
                presence = evaluate_presence(user_id, result["objects"])
                danger_cleared = presence["danger_cleared"]
                static_notice = presence["static_notice"]

                alert_is_new = has_new_alert(user_id, result["objects"])

                stage_times["danger_logic"] = (time.perf_counter() - t3) * 1000
                tracker.record_stage("danger_logic", stage_times["danger_logic"])

                stage_times["db_write"] = db_writer.last_amortized_ms()
                tracker.record_stage("db_write", stage_times["db_write"])

                t4 = time.perf_counter()

                from services.user_service import build_detection_entry
                record_id, detection_entry = build_detection_entry(user_id, result, session_id=session_id)

                processing_ms = (t4 - start) * 1000

                # Downlink mirror of the uplink probe: a tiny marker sent immediately
                # BEFORE the result, so the client can time the gap between their two
                # arrivals on its own clock alone. It must come first, not after —
                # a trailing marker would sit in the browser's event queue behind the
                # result handler's rendering and speech work, and would measure that
                # instead of the wire. Its own send cost is measured and excluded from
                # the `response` stage below, so probed frames are not penalised.
                probe_cost = 0.0
                if probe_this_frame:
                    tp = time.perf_counter()
                    await websocket.send_json({"type": "dl_probe"})
                    probe_cost = time.perf_counter() - tp

                await websocket.send_json({
                    "type": "result",
                    "status": "success",
                    "frame": frame_count,
                    "record_id": record_id,
                    "latency_ms": round(processing_ms, 1),
                    "danger": is_danger,
                    "danger_cleared": danger_cleared,
                    "clearance_message": "Path Clear" if danger_cleared else None,
                    "static_notice": static_notice,
                    "alert_is_new": alert_is_new,
                    "alert_level": result["alert_level"],
                    "distance": result["distance"],
                    "objects": result["objects"]
                })

                stage_times["response"] = ((time.perf_counter() - t4) - probe_cost) * 1000
                tracker.record_stage("response", stage_times["response"])

                latency = tracker.end_timer(start, success=True)
                counted = True

                perf_history.record_frame(latency, True, stage_times, user_id=user_id)

                db_writer.queue_detection(detection_entry)
                db_writer.note_frame_count(session_id, frame_count)

            except ValueError as e:
                if not counted:
                    perf_history.record_frame(
                        tracker.end_timer(start, success=False, outcome="reject"),
                        False, user_id=user_id, outcome="reject",
                    )
                danger_cleared = evaluate_presence(user_id, [])["danger_cleared"]
                await websocket.send_json({
                    "type": "error",
                    "frame": frame_count,
                    "detail": str(e),
                    "danger_cleared": danger_cleared,
                    "clearance_message": "Path Clear" if danger_cleared else None
                })

            except Exception as e:
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
        clear_cache(user_id)
        clear_tracker(user_id)
        stop_session(session_id)