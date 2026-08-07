"""Global, runtime-tunable streaming parameters (input_size, compression, pipeline depth)."""

import logging
from typing import Any

from core.database import get_db
from core.config import TARGET_SIZE, MIN_INPUT_SIZE, MAX_INPUT_SIZE

logger = logging.getLogger(__name__)

_DOC_ID = "stream"

LIMITS = {
    "input_size":          {"min": MIN_INPUT_SIZE, "max": MAX_INPUT_SIZE, "step": 32},
    "compression_percent": {"min": 0,              "max": 95,             "step": 5},
    "max_inflight":        {"min": 1,              "max": 16,             "step": 1},
}

DEFAULTS = {
    "input_size":          TARGET_SIZE,
    "compression_percent": 75,
    "max_inflight":        6,
}

# Cache read on every WebSocket connect; written through on every admin change.
_cache: dict[str, int] = dict(DEFAULTS)


def _collection():
    return get_db()["app_config"]


def _clamp(field: str, value: Any) -> int:
    limits = LIMITS[field]
    return max(limits["min"], min(limits["max"], int(value)))


def load_stream_config() -> dict[str, int]:
    """Read the stored config into the cache. Called once at startup."""
    global _cache
    try:
        doc = _collection().find_one({"_id": _DOC_ID})
    except Exception as e:
        logger.warning(f"stream config load failed, using defaults: {e}")
        return dict(_cache)

    if not doc:
        logger.info("No stored stream config — using defaults")
        return dict(_cache)

    merged = dict(DEFAULTS)
    for field in DEFAULTS:
        if field in doc:
            try:
                merged[field] = _clamp(field, doc[field])
            except (TypeError, ValueError):
                logger.warning(f"stream config: bad value for {field!r}, using default")

    _cache = merged
    logger.info(f"Stream config loaded: {_cache}")
    return dict(_cache)


def get_stream_config() -> dict[str, int]:
    return dict(_cache)


def set_stream_config(updates: dict[str, Any]) -> dict[str, int]:
    """Apply a partial update, clamped, and persist it."""
    global _cache

    changes: dict[str, int] = {}
    for field in DEFAULTS:
        if field in updates and updates[field] is not None:
            try:
                changes[field] = _clamp(field, updates[field])
            except (TypeError, ValueError):
                raise ValueError(f"{field} must be a number")

    if not changes:
        return dict(_cache)

    merged = {**_cache, **changes}
    _collection().update_one({"_id": _DOC_ID}, {"$set": merged}, upsert=True)
    _cache = merged
    logger.info(f"Stream config updated: {changes}")
    return dict(_cache)


def reset_stream_config() -> dict[str, int]:
    global _cache
    _collection().delete_one({"_id": _DOC_ID})
    _cache = dict(DEFAULTS)
    logger.info("Stream config reset to defaults")
    return dict(_cache)
