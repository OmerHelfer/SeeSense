"""
Persistent performance history — per-minute rollups in MongoDB.

The live PerformanceTracker (utils/metrics.py) only keeps an in-memory sliding
window that resets on restart. To support time-range analytics on the admin page
(last 30m / 1h / day / week / month / ... / year / custom), we accumulate metrics
into a per-minute bucket and flush completed buckets to the `perf_history`
collection. Range queries then aggregate the buckets between two timestamps.

NOTE: history only exists going forward from when this module started recording —
there is no retroactive data. A reset (reset_history) drops everything.

Each bucket doc:
{
  minute_ts: <epoch seconds, minute-aligned>,   # unique key
  created_at: <datetime, for TTL expiry>,
  lat:   {sum, min, max, n},                     # server-side per-frame latency (ms)
  rtt:   {sum, min, max, n},                     # client-reported end-to-end RTT (ms)
  frames, success, fail,                          # counts
  stages: { <stage>: {sum, min, max, n}, ... }    # per-pipeline-stage latency (ms)
}
"""

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
_bucket = None  # current in-progress minute accumulator


def _col():
    return get_db()["perf_history"]


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


def _new_bucket(minute_ts: int) -> dict:
    return {
        "minute_ts": minute_ts,
        "created_at": datetime.utcnow(),
        "lat": _new_metric(),
        "rtt": _new_metric(),
        "frames": 0,
        "success": 0,
        "fail": 0,
        "stages": {},
    }


def _rollover_locked():
    """Ensure _bucket is the current minute; flush the previous one if it rolled over.
    Caller must hold _lock."""
    global _bucket
    minute = _current_minute()
    if _bucket is None:
        _bucket = _new_bucket(minute)
    elif _bucket["minute_ts"] != minute:
        completed = _bucket
        _bucket = _new_bucket(minute)
        _flush_async(completed)


def record_frame(latency_ms: float, success: bool, stages: dict | None = None):
    """Record one processed frame (latency + success + optional per-stage times)."""
    with _lock:
        _rollover_locked()
        _bucket["frames"] += 1
        if success:
            _bucket["success"] += 1
        else:
            _bucket["fail"] += 1
        _acc(_bucket["lat"], latency_ms)
        if stages:
            for name, ms in stages.items():
                _acc(_bucket["stages"].setdefault(name, _new_metric()), ms)


def record_rtt(rtt_ms: float):
    """Record one client-reported end-to-end RTT sample."""
    with _lock:
        _rollover_locked()
        _acc(_bucket["rtt"], rtt_ms)


# ==================== Flushing ====================

def _flush_async(bucket: dict):
    threading.Thread(target=_flush, args=(bucket,), daemon=True).start()


def _flush(bucket: dict):
    # Skip empty buckets (no frames and no rtt samples)
    if bucket["frames"] == 0 and bucket["rtt"]["n"] == 0:
        return
    try:
        _col().replace_one({"minute_ts": bucket["minute_ts"]}, bucket, upsert=True)
    except Exception as e:
        logger.error(f"perf_history flush failed: {e}")


def flush_now():
    """Persist the current in-progress bucket so range queries include the most
    recent (sub-minute) data. Upsert keyed by minute_ts → no double counting."""
    with _lock:
        if _bucket and (_bucket["frames"] > 0 or _bucket["rtt"]["n"] > 0):
            _flush(dict(_bucket))


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


def _finalize(metric: dict) -> dict:
    n = metric["n"]
    return {
        "avg_ms": round(metric["sum"] / n, 2) if n else 0.0,
        "min_ms": round(metric["min"], 2) if metric["min"] is not None else 0.0,
        "max_ms": round(metric["max"], 2) if metric["max"] is not None else 0.0,
    }


def query_range(start_ts: int | None, end_ts: int | None = None) -> dict:
    """
    Aggregate all minute buckets in [start_ts, end_ts] into a status report shaped
    like PerformanceTracker.get_status() (minus the live-only rtt_history chart).
    start_ts=None means "since the beginning of recording".
    """
    flush_now()  # include the current partial minute

    query = {}
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

    # Span for FPS: from first bucket start to last bucket end (+60s), else 0
    span_seconds = (max_minute + 60 - min_minute) if (min_minute is not None) else 0
    overall_fps = round(total / span_seconds, 2) if span_seconds > 0 else 0.0
    # Throughput over a range = successful frames per second across the measured span
    # (the useful-output equivalent of the live 10s-window throughput).
    throughput_ps = round(success / span_seconds, 2) if span_seconds > 0 else 0.0

    return {
        "mode": "range",
        "range": {
            "start_ts": start_ts,
            "end_ts": end_ts,
            "buckets": len(buckets),
            "span_seconds": span_seconds,
        },
        "uptime_seconds": span_seconds,
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
            "per_second": throughput_ps,
            "window_seconds": span_seconds,
            "frames_in_window": success,
        },
        "rtt_history": [],  # not available for aggregated ranges (live view only)
        "fps": {
            "server_capacity": 0.0,
            "server_actual": 0.0,
            "client_actual": 0.0,
            "overall": overall_fps,
        },
    }


# ==================== Reset ====================

def reset_history():
    """Drop all persisted performance history (part of the admin 'reset' button)."""
    global _bucket
    with _lock:
        _bucket = None
    try:
        _col().delete_many({})
        logger.info("perf_history reset — all persisted buckets dropped")
    except Exception as e:
        logger.error(f"perf_history reset failed: {e}")
