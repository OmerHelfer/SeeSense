import uuid
import time
import threading
import logging
from datetime import datetime, timedelta

from core.database import get_db
from services.user_service import add_detection_record

logger = logging.getLogger(__name__)


def _sessions():
    return get_db()["sessions"]


# ==================== In-Memory Cache ====================
# Caches session state and user settings per user to avoid DB calls every frame.
# Updated by pause/resume endpoints and settings changes.
# user_id → {"paused": bool, "settings": dict, "session_id": str}
_user_cache = {}

# Track previous danger state per user (for "danger cleared" detection)
_ws_previous_danger_state = {}

# Track last-announced alert level per (user_id, track_id) — for alert dedup.
# user_id → {track_id: {"level": str, "seen": monotonic_seconds}}
_track_alert_state = {}

# Alert levels ranked, so dedup can distinguish an ESCALATION (worth interrupting
# the user for) from a de-escalation (not news).
_ALERT_RANK = {"none": 0, "low": 1, "high": 2}

# How long a track's last-known level is remembered after it stops appearing.
# Objects drop out of the frame's object list whenever their confidence dips under
# the user's sensitivity threshold, while the track itself is still very much
# alive — expiring them instantly made them read as "new" again a frame later.
_ALERT_STATE_TTL = 5.0  # seconds


def get_cached_state(user_id: str) -> dict:
    """Get cached session state for a user."""
    return _user_cache.get(user_id, {})


def update_cache(user_id: str, **kwargs):
    """Update cache for a user. Called by pause/resume/settings endpoints."""
    if user_id not in _user_cache:
        _user_cache[user_id] = {}
    _user_cache[user_id].update(kwargs)


def clear_cache(user_id: str):
    """Clear cache when user disconnects. Also stamps last_seen for admin views."""
    _user_cache.pop(user_id, None)
    _ws_previous_danger_state.pop(user_id, None)
    _track_alert_state.pop(user_id, None)
    try:
        get_db()["users"].update_one(
            {"user_id": user_id},
            {"$set": {"last_seen": datetime.now().isoformat()}},
        )
    except Exception as e:
        logger.error(f"Failed to stamp last_seen for {user_id}: {e}")


# ==================== Online presence ====================
# A user is "online" while they have a live streaming WebSocket — which is exactly
# when they have an entry in _user_cache (added on WS connect, removed on disconnect).

def get_online_user_ids() -> set:
    """Set of user_ids currently connected via the streaming WebSocket."""
    return set(_user_cache.keys())


def is_user_online(user_id: str) -> bool:
    return user_id in _user_cache


# ==================== Session Management ====================

def get_or_create_session(user_id: str) -> str:
    """
    Returns an active session_id for the user.
    - If an active session exists → return it.
    - If a recent stopped session exists (within 15 min) → resume it.
    - Otherwise → create a new session.
    """
    sessions = _sessions()

    # Check for existing active session
    existing = sessions.find_one({"user_id": user_id, "status": "active"})
    if existing:
        logger.info(f"Resuming active session: {existing['session_id']}, user={user_id}")
        return existing["session_id"]

    # Check for recently stopped session (within 15 minutes)
    cutoff = (datetime.now() - timedelta(minutes=15)).isoformat()
    recent = sessions.find_one({
        "user_id": user_id,
        "status": "stopped",
        "stopped_at": {"$gte": cutoff}
    })

    if recent:
        session_id = recent["session_id"]
        sessions.update_one(
            {"session_id": session_id},
            {"$set": {"status": "active", "paused": False},
             "$unset": {"stopped_at": ""}}
        )
        logger.info(f"Resumed recent session: {session_id}, user={user_id}")
        return session_id

    # Create new session
    session_id = str(uuid.uuid4())
    sessions.insert_one({
        "session_id": session_id,
        "user_id": user_id,
        "status": "active",
        "started_at": datetime.now().isoformat(),
        "frame_count": 0
    })
    logger.info(f"Created new session: {session_id}, user={user_id}")
    return session_id


def stop_session(session_id: str):
    """Mark a session as stopped."""
    _sessions().update_one(
        {"session_id": session_id, "status": "active"},
        {"$set": {"status": "stopped", "stopped_at": datetime.now().isoformat()}}
    )
    logger.info(f"Session stopped: {session_id}")


def get_active_session(user_id: str) -> dict | None:
    """Return the active session document for a user, or None."""
    return _sessions().find_one({"user_id": user_id, "status": "active"})


# ==================== Danger State Tracking ====================

def check_danger_cleared(user_id: str, is_danger: bool) -> bool:
    """
    Returns True if danger was active last frame and is now cleared.
    Updates the danger state tracker.
    """
    was_danger = _ws_previous_danger_state.get(user_id, False)
    _ws_previous_danger_state[user_id] = is_danger
    return was_danger and not is_danger


def has_new_alert(user_id: str, objects: list[dict]) -> bool:
    """
    Alert dedup — returns True only if some object's danger level has ESCALATED
    since we last saw it (keyed by its track_id), e.g. a parked car sitting at
    "low" every frame won't keep re-triggering TTS/haptic, but a genuine
    none→low or low→high transition will.

    Escalation only, deliberately: an earlier version fired on any change, which
    also matched high→low. Combined with an object oscillating across the
    approach threshold, that alerted in BOTH directions and produced a continuous
    stream of voice/haptic for a single stationary object. A de-escalation still
    updates the HUD; it just doesn't interrupt the user.

    Detections with no owning track (track_id -1) are skipped entirely. They have
    no stable identity, so they all collided on one key, overwrote each other's
    state, and re-fired on every frame.
    """
    now = time.monotonic()
    state = _track_alert_state.setdefault(user_id, {})
    is_new = False

    for obj in objects:
        track_id = obj.get("motion", {}).get("track_id", -1)
        if track_id < 0:
            continue

        level = obj.get("alert_level", "none")
        prev = state.get(track_id)
        prev_level = prev["level"] if prev else "none"

        if _ALERT_RANK.get(level, 0) > _ALERT_RANK.get(prev_level, 0):
            is_new = True

        state[track_id] = {"level": level, "seen": now}

    # Expire on a timer rather than on a single missed frame, so a momentary dip
    # below the confidence threshold doesn't make a still-present object "new".
    for stale_id in [t for t, s in state.items() if now - s["seen"] > _ALERT_STATE_TTL]:
        del state[stale_id]

    return is_new


# ==================== Background DB Writes ====================

def save_frame_count_background(session_id: str, frame_count: int):
    """Kick off a background thread to update frame count (non-blocking)."""
    thread = threading.Thread(
        target=_save_frame_count,
        args=(session_id, frame_count),
        daemon=True
    )
    thread.start()


def _save_frame_count(session_id: str, frame_count: int):
    """Background frame count update — runs in a separate thread."""
    try:
        _sessions().update_one(
            {"session_id": session_id},
            {"$set": {"frame_count": frame_count}}
        )
    except Exception as e:
        logger.error(f"Background frame count update failed: {e}")