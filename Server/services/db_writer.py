
import logging
import threading
import time
from collections import deque

logger = logging.getLogger(__name__)

FLUSH_INTERVAL_SEC = 1.0

MAX_PENDING = 5000

_lock = threading.Lock()
_pending_detections = deque()
_pending_frame_counts = {}
_last_amortized_ms = 0.0
_last_flush_ms = 0.0
_last_flush_records = 0
_dropped = 0

_thread = None
_stop = threading.Event()



def queue_detection(entry: dict):
    global _dropped
    with _lock:
        if len(_pending_detections) >= MAX_PENDING:
            _pending_detections.popleft()
            _dropped += 1
            if _dropped % 500 == 1:
                logger.warning(
                    f"db_writer buffer full ({MAX_PENDING}) — dropped {_dropped} "
                    f"detection records; the database is not keeping up"
                )
        _pending_detections.append(entry)


def note_frame_count(session_id: str, frame_count: int):
    if not session_id:
        return
    with _lock:
        _pending_frame_counts[session_id] = frame_count


def last_amortized_ms() -> float:
    return _last_amortized_ms


def last_flush_ms() -> float:
    return _last_flush_ms


def last_flush_records() -> int:
    return _last_flush_records


def start():
    global _thread
    if _thread and _thread.is_alive():
        return
    _stop.clear()
    _thread = threading.Thread(target=_run, name="db-writer", daemon=True)
    _thread.start()
    logger.info(f"db_writer started (flush every {FLUSH_INTERVAL_SEC}s)")


def shutdown(timeout: float = 5.0):
    _stop.set()
    if _thread and _thread.is_alive():
        _thread.join(timeout=timeout)
    flush_now()
    logger.info("db_writer stopped and flushed")


def flush_now():
    _flush()


def pending_counts() -> tuple:
    with _lock:
        return len(_pending_detections), len(_pending_frame_counts)



def _run():
    while not _stop.is_set():
        _stop.wait(FLUSH_INTERVAL_SEC)
        try:
            _flush()
        except Exception as e:
            logger.error(f"db_writer flush failed: {e}", exc_info=True)


def _flush():
    global _last_amortized_ms, _last_flush_ms, _last_flush_records

    with _lock:
        detections = list(_pending_detections)
        _pending_detections.clear()
        frame_counts = dict(_pending_frame_counts)
        _pending_frame_counts.clear()

    if not detections and not frame_counts:
        return

    from core.database import get_db
    db = get_db()
    started = time.perf_counter()
    written = 0

    if detections:
        try:
            db["detection_history"].insert_many(detections, ordered=False)
            written += len(detections)
        except Exception as e:
            logger.warning(f"detection batch insert failed ({len(detections)} rows): {e}")

    if frame_counts:
        try:
            from pymongo import UpdateOne
            db["sessions"].bulk_write(
                [UpdateOne({"session_id": sid}, {"$set": {"frame_count": n}})
                 for sid, n in frame_counts.items()],
                ordered=False,
            )
            written += len(frame_counts)
        except Exception as e:
            logger.warning(f"frame-count bulk update failed: {e}")

    elapsed_ms = (time.perf_counter() - started) * 1000
    if written:
        _last_flush_ms = elapsed_ms
        _last_flush_records = written
        _last_amortized_ms = elapsed_ms / written
        if elapsed_ms > 500:
            logger.warning(
                f"db_writer flush took {elapsed_ms:.0f}ms for {written} records "
                f"({_last_amortized_ms:.1f}ms each) — database is slow"
            )
