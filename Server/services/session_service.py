import uuid
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


def get_cached_state(user_id: str) -> dict:
    """Get cached session state for a user."""
    return _user_cache.get(user_id, {})


def update_cache(user_id: str, **kwargs):
    """Update cache for a user. Called by pause/resume/settings endpoints."""
    if user_id not in _user_cache:
        _user_cache[user_id] = {}
    _user_cache[user_id].update(kwargs)


def clear_cache(user_id: str):
    """Clear cache when user disconnects."""
    _user_cache.pop(user_id, None)
    _ws_previous_danger_state.pop(user_id, None)


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


# ==================== Background DB Writes ====================

def save_frame_data_background(session_id: str, user_id: str, result: dict, frame_count: int):
    """Kick off a background thread to write frame data to DB (non-blocking)."""
    thread = threading.Thread(
        target=_save_frame_data,
        args=(session_id, user_id, result, frame_count),
        daemon=True
    )
    thread.start()


def _save_frame_data(session_id: str, user_id: str, result: dict, frame_count: int):
    """Background DB write — runs in a separate thread after response is sent."""
    try:
        _sessions().update_one(
            {"session_id": session_id},
            {"$set": {"frame_count": frame_count}}
        )
        add_detection_record(user_id, result, session_id=session_id)
    except Exception as e:
        logger.error(f"Background DB write failed: {e}")