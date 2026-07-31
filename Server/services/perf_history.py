"""
Persistent performance history — per-minute rollups in MongoDB.

The live PerformanceTracker (utils/metrics.py) only keeps an in-memory sliding
window that resets on restart. To support time-range analytics on the admin page
(last 30m / 1h / day / week / month / ... / year / custom), we accumulate metrics
into a per-minute bucket and flush completed buckets to the `perf_history`
collection. Range queries then aggregate the buckets between two timestamps.

NOTE: history only exists going forward from when this module started recording —
there is no retroactive data. A reset (reset_history) drops everything.

The moment recording began is stored separately, as a single doc in `perf_meta`,
so the measured span the admin page shows is a clock rather than a property of
whichever buckets happen to still exist. See "Recording-start marker" below.

Each bucket doc:
{
  minute_ts: <epoch seconds, minute-aligned>,   # key, together with user_id
  user_id: <str | None>,                         # who produced these frames
  created_at: <datetime, for TTL expiry>,
  lat:   {sum, min, max, n},                     # server-side per-frame latency (ms)
  rtt:   {sum, min, max, n},                     # client-reported end-to-end RTT (ms)
  frames, success, fail,                          # counts
  stages: { <stage>: {sum, min, max, n}, ... },   # per-pipeline-stage latency (ms)
  first_frame_ts, last_frame_ts,                  # epoch secs of this minute's first
                                                  # and last frame — the ACTIVE span
                                                  # inside the minute (see below)
}

first_frame_ts / last_frame_ts exist so a rate can be measured against time actually
spent streaming rather than against the calendar. A bucket is a whole minute, but a
user may have streamed for eight seconds of it; dividing by the minute reports an FPS
six times lower than the one the user experienced. Buckets written before these
fields existed have neither, and fall back to assuming the whole minute.
"""

import copy
import time
import threading
import logging
from datetime import datetime

from core.database import get_db

logger = logging.getLogger(__name__)

# Retention for the TTL index (see database.py). ~13 months so a "last year"
# range always has data available.
RETENTION_SECONDS = 400 * 24 * 3600

_lock = threading.Lock()
# Current in-progress minute, accumulated per user: {user_id or _UNATTRIBUTED: bucket}.
# One doc per (minute, user) is written on rollover — with a handful of concurrent
# users that is a few small writes a minute, and it is what makes a per-user view
# possible without a second storage path.
_buckets: dict = {}
_bucket_minute = None


def _col():
    return get_db()["perf_history"]


def _meta_col():
    return get_db()["perf_meta"]


# ==================== Recording-start marker ====================
#
# The all-users measured span used to be derived from the oldest bucket in the
# collection. That made it a function of surviving data rather than a clock:
# deleting one user's buckets (a scoped reset, or TTL expiry) removed the row
# that WAS the minimum, so the global span silently jumped forward. The origin
# is now stored explicitly and only a global reset clears it.

_META_ID = "recording"

# Set once we know the marker exists, so the common case costs no write. Only a
# global reset clears it (a scoped reset must not touch the marker).
_recording_start_known = False


def note_recording_start(ts: int):
    """Record `ts` as the moment recording began, unless a marker already exists.

    $setOnInsert, so the earliest writer wins and repeat calls are harmless —
    concurrent bucket flushes all racing to create it is fine.
    """
    global _recording_start_known
    try:
        _meta_col().update_one(
            {"_id": _META_ID},
            {"$setOnInsert": {"started_at": int(ts)}},
            upsert=True,
        )
        _recording_start_known = True
    except Exception as e:
        logger.error(f"perf_history recording-start write failed: {e}")


def get_recording_start() -> int | None:
    """Epoch second recording began, or None if nothing has been recorded yet."""
    try:
        doc = _meta_col().find_one({"_id": _META_ID})
        return doc.get("started_at") if doc else None
    except Exception as e:
        logger.error(f"perf_history recording-start read failed: {e}")
        return None


def backfill_recording_start():
    """Adopt the oldest existing bucket as the origin, for history recorded before
    the marker existed. Called at startup so the marker is always in place before
    any reset can delete the bucket it would have been derived from.
    """
    global _recording_start_known
    try:
        if _meta_col().find_one({"_id": _META_ID}):
            _recording_start_known = True
            return
        oldest = _col().find_one({}, sort=[("minute_ts", 1)])
        if oldest and oldest.get("minute_ts") is not None:
            note_recording_start(oldest["minute_ts"])
            logger.info(f"perf_history recording start backfilled to {oldest['minute_ts']}")
    except Exception as e:
        logger.error(f"perf_history recording-start backfill failed: {e}")


# ==================== Accumulation ====================

def _new_metric():
    return {"sum": 0.0, "min": None, "max": None, "n": 0}


def _acc(metric: dict, value: float):
    metric["sum"] += value
    metric["n"] += 1
    metric["min"] = value if metric["min"] is None else min(metric["min"], value)
    metric["max"] = value if metric["max"] is None else max(metric["max"], value)


def _current_minute() -> int:
    return int(time.time() // 60) * 60


# Bucket key used for samples that arrive without a user_id. Kept distinct from a
# real user id so it can never be returned by a per-user query, while still being
# counted in the global totals.
_UNATTRIBUTED = "_global"


def _new_bucket(minute_ts: int, user_id: str | None = None) -> dict:
    return {
        "minute_ts": minute_ts,
        "user_id": user_id,
        "created_at": datetime.utcnow(),
        "lat": _new_metric(),
        "rtt": _new_metric(),
        "frames": 0,
        "success": 0,
        "fail": 0,
        "stages": {},
        # Wall-clock of the first and last frame in this minute. Their difference is
        # the time genuinely spent streaming, which is what FPS should be measured
        # against — see the module docstring.
        "first_frame_ts": None,
        "last_frame_ts": None,
    }


def _rollover_locked():
    """Ensure _buckets holds the current minute; flush the previous minute's buckets
    if it rolled over. Caller must hold _lock."""
    global _buckets, _bucket_minute
    minute = _current_minute()
    if _bucket_minute is None:
        _bucket_minute = minute
    elif _bucket_minute != minute:
        completed = _buckets
        _buckets = {}
        _bucket_minute = minute
        for b in completed.values():
            _flush_async(b)


def _bucket_for_locked(user_id: str | None) -> dict:
    """Get (or create) this minute's bucket for a user. Caller must hold _lock."""
    key = user_id or _UNATTRIBUTED
    bucket = _buckets.get(key)
    if bucket is None:
        bucket = _new_bucket(_bucket_minute, user_id)
        _buckets[key] = bucket
    return bucket


def record_frame(latency_ms: float, success: bool, stages: dict | None = None,
                 user_id: str | None = None):
    """
    Record one processed frame (latency + success + optional per-stage times).

    user_id attributes the sample to a user so the admin page can show one user's
    history. Omitting it still counts toward the global totals — attribution is
    additive, never a filter on the aggregate.
    """
    now = time.time()
    with _lock:
        _rollover_locked()
        bucket = _bucket_for_locked(user_id)
        if bucket["first_frame_ts"] is None:
            bucket["first_frame_ts"] = now
        bucket["last_frame_ts"] = now
        bucket["frames"] += 1
        if success:
            bucket["success"] += 1
        else:
            bucket["fail"] += 1
        _acc(bucket["lat"], latency_ms)
        if stages:
            for name, ms in stages.items():
                _acc(bucket["stages"].setdefault(name, _new_metric()), ms)


def record_rtt(rtt_ms: float, user_id: str | None = None):
    """Record one client-reported end-to-end RTT sample."""
    with _lock:
        _rollover_locked()
        _acc(_bucket_for_locked(user_id)["rtt"], rtt_ms)


# ==================== Flushing ====================

def _flush_async(bucket: dict):
    threading.Thread(target=_flush, args=(bucket,), daemon=True).start()


def _flush(bucket: dict):
    # Skip empty buckets (no frames and no rtt samples)
    if bucket["frames"] == 0 and bucket["rtt"]["n"] == 0:
        return
    # Anchor the recording clock to this bucket's minute the first time anything
    # is persisted. Done here rather than in record_frame so the hot path stays
    # free of Mongo, and the minute_ts is an accurate origin either way.
    if not _recording_start_known:
        note_recording_start(bucket["minute_ts"])
    try:
        # Keyed by (minute_ts, user_id) so re-flushing the in-progress minute
        # overwrites rather than duplicates. Legacy docs written before per-user
        # attribution have no user_id field; {"user_id": None} matches those too,
        # which is correct — they are unattributed by definition.
        _col().replace_one(
            {"minute_ts": bucket["minute_ts"], "user_id": bucket.get("user_id")},
            bucket,
            upsert=True,
        )
    except Exception as e:
        logger.error(f"perf_history flush failed: {e}")


# Minimum gap between on-demand flushes. The admin page polls every 3s, and each
# poll deepcopied every bucket and wrote one doc per active user — CPU and Mongo
# work competing for the same vCPUs the model runs on, so simply watching the page
# degraded the thing being measured. Throttling costs at most this much freshness
# on the in-progress minute, which is well under one bucket.
_FLUSH_MIN_INTERVAL_S = 20
_last_flush_at = 0.0


def flush_now(force: bool = False):
    """Persist the current in-progress buckets so queries include the most recent
    (sub-minute) data. Upsert keyed by (minute_ts, user_id) → no double counting.

    Throttled: repeat calls within _FLUSH_MIN_INTERVAL_S are no-ops. Pass force=True
    when completeness matters more than cost (before a reset, on shutdown).
    """
    global _last_flush_at
    now = time.time()
    with _lock:
        if not force and (now - _last_flush_at) < _FLUSH_MIN_INTERVAL_S:
            return
        _last_flush_at = now
        # deepcopy, not dict(): a shallow copy shares the nested lat/rtt/stages
        # dicts with the live bucket, so record_frame keeps mutating them while
        # the write runs outside the lock. That persists a torn doc — frames /
        # success / fail frozen at copy time, but lat.n and the stage counts as
        # of whenever the BSON encoder happened to read them.
        pending = [copy.deepcopy(b) for b in _buckets.values()
                   if b["frames"] > 0 or b["rtt"]["n"] > 0]
    # Flush outside the lock — a slow write must not stall the frame hot path.
    for b in pending:
        _flush(b)


# ==================== Querying ====================

# Preset range keys → lookback seconds (None = all / since start)
RANGE_SECONDS = {
    "start": None, "all": None,
    "30m": 1800,
    "1h": 3600,
    "1d": 86400,
    "1w": 604800,
    "1mo": 2592000,      # 30 days
    "3mo": 7776000,      # 90 days
    "6mo": 15552000,     # 180 days
    "1y": 31536000,      # 365 days
}


def _agg_metric(dst: dict, src: dict):
    dst["sum"] += src.get("sum", 0.0)
    dst["n"] += src.get("n", 0)
    if src.get("min") is not None:
        dst["min"] = src["min"] if dst["min"] is None else min(dst["min"], src["min"])
    if src.get("max") is not None:
        dst["max"] = src["max"] if dst["max"] is None else max(dst["max"], src["max"])


def _active_span(bucket: dict) -> tuple[float, int, int]:
    """How long this bucket was actually streaming, and the frames to credit to it.

    Returns (seconds, frames, successes) to be summed across buckets; dividing the
    summed frames by the summed seconds gives FPS over time spent streaming.

    n frames spanning (last - first) seconds cover n-1 intervals, so the real
    duration is one average interval longer than the timestamps suggest:
    span * n / (n - 1). That makes frames / duration reduce to the jitter-free
    (n - 1) / span rate metrics.py uses, while still yielding a duration that can
    be summed and displayed.

    A single frame is skipped entirely: one sample cannot establish a rate, and
    charging it a whole minute of "streaming time" would drag the average down
    with an interval nobody measured.

    Buckets written before the timestamps existed fall back to the whole minute —
    the old behaviour, which is the best that can be said about data that was
    never recorded.
    """
    frames = bucket.get("frames", 0)
    if frames <= 0:
        return 0.0, 0, 0
    successes = bucket.get("success", 0)

    first, last = bucket.get("first_frame_ts"), bucket.get("last_frame_ts")
    if first is None or last is None:
        return 60.0, frames, successes          # legacy bucket

    span = last - first
    if frames < 2 or span <= 0:
        return 0.0, 0, 0
    return span * frames / (frames - 1), frames, successes


def _finalize(metric: dict) -> dict:
    n = metric["n"]
    return {
        "avg_ms": round(metric["sum"] / n, 2) if n else 0.0,
        "min_ms": round(metric["min"], 2) if metric["min"] is not None else 0.0,
        "max_ms": round(metric["max"], 2) if metric["max"] is not None else 0.0,
    }


def query_range(start_ts: int | None, end_ts: int | None = None,
                user_id: str | None = None) -> dict:
    """
    Aggregate all minute buckets in [start_ts, end_ts] into a status report shaped
    like PerformanceTracker.get_status() (minus the live-only rtt_history chart).
    start_ts=None means "since the beginning of recording".

    user_id restricts the aggregate to one user's frames. Note that only data
    recorded AFTER per-user attribution was added carries a user_id — older buckets
    are unattributed and are correctly excluded from a per-user view (we don't know
    whose they were) while still counting toward the global totals.
    """
    flush_now()  # include the current partial minute

    query = {}
    if user_id is not None:
        query["user_id"] = user_id
    if start_ts is not None:
        query["minute_ts"] = {"$gte": int(start_ts)}
    if end_ts is not None:
        query.setdefault("minute_ts", {})["$lte"] = int(end_ts)

    buckets = list(_col().find(query))

    lat = _new_metric()
    rtt = _new_metric()
    stages: dict[str, dict] = {}
    total = success = fail = 0
    min_minute = max_minute = None
    active_seconds = 0.0
    active_frames = active_success = 0

    for b in buckets:
        _agg_metric(lat, b.get("lat", {}))
        _agg_metric(rtt, b.get("rtt", {}))
        total += b.get("frames", 0)
        success += b.get("success", 0)
        fail += b.get("fail", 0)
        for name, s in (b.get("stages") or {}).items():
            _agg_metric(stages.setdefault(name, _new_metric()), s)
        m = b.get("minute_ts")
        if m is not None:
            min_minute = m if min_minute is None else min(min_minute, m)
            max_minute = m if max_minute is None else max(max_minute, m)
        dur, n_frames, n_success = _active_span(b)
        active_seconds += dur
        active_frames += n_frames
        active_success += n_success

    # Span for FPS: from first bucket start to last bucket end (+60s), else 0
    span_seconds = (max_minute + 60 - min_minute) if (min_minute is not None) else 0
    overall_fps = round(total / span_seconds, 2) if span_seconds > 0 else 0.0
    # Throughput over a range = successful frames per second across the measured span
    # (the useful-output equivalent of the live 10s-window throughput).
    throughput_ps = round(success / span_seconds, 2) if span_seconds > 0 else 0.0

    # The rates a person actually experienced: measured only over time spent
    # streaming. `overall_fps` above divides by the calendar, so it is really
    # "capacity x duty cycle" — a user who streams 3 minutes an hour reads ~1.5 FPS
    # while every one of their frames came back at 30. Both are reported: this is
    # the rate, that is the utilisation.
    active_fps = round(active_frames / active_seconds, 2) if active_seconds > 0 else 0.0
    active_throughput = round(active_success / active_seconds, 2) if active_seconds > 0 else 0.0

    # The span the PAGE displays ("טווח נמדד") is a clock, not a property of the
    # surviving rows: for the all-users view it runs from the recording-start
    # marker, so resetting one user cannot move it. Per-user views keep meaning
    # "since that user's first recorded frame", which is what their label says.
    # span_seconds above stays bucket-derived — it is the FPS/throughput divisor,
    # where dividing by wall-clock time (including long idle stretches) would
    # understate the measured rates.
    recording_start = get_recording_start() if user_id is None else None
    if recording_start is not None:
        display_first = recording_start
        display_span = max(0, int(time.time()) - recording_start)
    else:
        display_first = min_minute
        display_span = span_seconds

    return {
        "mode": "range",
        "user_id": user_id,
        "range": {
            "start_ts": start_ts,
            "end_ts": end_ts,
            "buckets": len(buckets),
            "span_seconds": span_seconds,   # bucket-derived; the FPS divisor
            "first_ts": display_first,      # clock origin for the displayed span
            "oldest_bucket_ts": min_minute,
            "last_ts": max_minute,
            # Time actually spent streaming. For one user this is their real
            # session time; aggregated over everyone it is the SUM of concurrent
            # sessions, so it can exceed the calendar span. The page labels the
            # two cases differently.
            "active_seconds": round(active_seconds),
        },
        "uptime_seconds": display_span,
        "total_frames": total,
        "success_count": success,
        "failure_count": fail,
        "server_latency": _finalize(lat),
        "client_rtt": {
            "avg_ms": _finalize(rtt)["avg_ms"],
            "min_ms": _finalize(rtt)["min_ms"],
            "max_ms": _finalize(rtt)["max_ms"],
        },
        "stage_latency": {name: _finalize(s) for name, s in stages.items()},
        "throughput": {
            # Successful frames per second of streaming — the rate that was really
            # achieved. `per_second` keeps the old calendar-based figure alongside.
            "active_per_second": active_throughput,
            "per_second": throughput_ps,
            "window_seconds": span_seconds,
            "active_seconds": round(active_seconds),
            "frames_in_window": success,
        },
        "rtt_history": [],  # not available for aggregated ranges (live view only)
        "fps": {
            "server_capacity": 0.0,
            "server_actual": 0.0,
            "client_actual": 0.0,
            "active": active_fps,       # while streaming — comparable to the live rates
            "overall": overall_fps,     # over the calendar — rate x utilisation
        },
    }


# ==================== Reset ====================

def reset_history(user_id: str | None = None):
    """
    Drop persisted performance history (part of the admin 'reset' button).

    user_id=None wipes everything. Passing a user_id deletes only that user's
    buckets and leaves every other user's history untouched.

    The in-progress in-memory bucket is discarded FIRST in both cases: it is
    already-counted data that has not been written yet, so leaving it would let
    the next flush immediately re-create rows for a user who was just reset.

    Only the global case clears the recording-start marker. A scoped reset must
    leave it alone — the all-users clock is not that user's to restart, and
    resetting it was exactly the bug this marker exists to prevent.
    """
    global _buckets, _bucket_minute, _recording_start_known
    with _lock:
        if user_id is None:
            _buckets = {}
            _bucket_minute = None
        else:
            _buckets.pop(user_id, None)

    if user_id is None:
        try:
            _meta_col().delete_one({"_id": _META_ID})
            _recording_start_known = False
        except Exception as e:
            logger.error(f"perf_history recording-start reset failed: {e}")
            raise

    try:
        result = _col().delete_many({} if user_id is None else {"user_id": user_id})
        scope = "all users" if user_id is None else f"user {user_id}"
        logger.info(f"perf_history reset — dropped {result.deleted_count} buckets for {scope}")
    except Exception as e:
        logger.error(f"perf_history reset failed: {e}")
        raise
