"""
Batched, off-hot-path persistence for the streaming pipeline.

The frame loop used to spawn TWO threads per frame — one to insert the detection
record, one to update the session's frame counter — each doing its own round trip
to MongoDB. At 40 FPS that is 80 new threads and 80 round trips per second, and
the database is in a different country from the server (~25-40ms per round trip),
so the work could not possibly keep up with the frames producing it. Threads piled
up, the GIL and the connection pool came under pressure, and the asyncio loop
serving the WebSocket got starved: results stopped arriving, the client's overlay
froze on its last boxes, and RTT spiked until the backlog drained.

Everything here happens AFTER the result has already been sent to the phone. The
record id is generated in memory before the insert, so nothing the user sees or
hears depends on when these rows actually land. That is what makes batching safe:
it changes when history is durable, never what the user is told.

Two writes, two different strategies:
  detections  — append-only, so they batch perfectly into one insert_many.
  frame count — a counter on ONE document per session. Writing it per frame was
                the worst offender: every write targeted the same document, so
                MongoDB serialised them. Only the latest value matters, so we keep
                the newest per session and write it once per flush.
"""

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
    """Buffer a detection-history document for the next batch insert."""
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
    """Record a session's latest frame count. Only the newest value is written."""
    if not session_id:
        return
    with _lock:
        _pending_frame_counts[session_id] = frame_count


def last_amortized_ms() -> float:
    """
    Real per-record cost of persisting a frame, in ms.

    This is what the admin page's db_write stage should show. The old value timed
    building a dict in memory and never touched the database at all, so it read
    0.0ms no matter how badly the writes were actually doing.
    """
    return _last_amortized_ms


def last_flush_ms() -> float:
    """
    Duration of the most recent batch flush, in ms — the whole round trip to
    MongoDB, BEFORE being divided by the number of records in it.

    This is the raw cost of talking to the database: one insert_many plus one
    bulk_write, against a cluster ~4,000 km away. last_amortized_ms above is this
    number divided by last_flush_records; both are off the frame's critical path
    (the flush runs on the writer thread, a second behind the frames it persists).

    Watch it for database health: batching is what makes a figure of this size
    affordable at all, and if it climbs while the record count stays flat, the
    problem is the database or the link to it, not the frame rate.
    """
    return _last_flush_ms


def last_flush_records() -> int:
    """How many records the most recent flush wrote. Makes last_flush_ms readable:
    150ms for 40 records and 150ms for 1 record are very different situations."""
    return _last_flush_records


def start():
    """Start the background writer. Safe to call more than once."""
    global _thread
    if _thread and _thread.is_alive():
        return
    _stop.clear()
    _thread = threading.Thread(target=_run, name="db-writer", daemon=True)
    _thread.start()
    logger.info(f"db_writer started (flush every {FLUSH_INTERVAL_SEC}s)")


def shutdown(timeout: float = 5.0):
    """Stop the writer and flush whatever is still buffered."""
    _stop.set()
    if _thread and _thread.is_alive():
        _thread.join(timeout=timeout)
    flush_now()
    logger.info("db_writer stopped and flushed")


def flush_now():
    """Force an immediate flush (shutdown, tests)."""
    _flush()


def pending_counts() -> tuple:
    """(detections, sessions) still buffered — for diagnostics."""
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
