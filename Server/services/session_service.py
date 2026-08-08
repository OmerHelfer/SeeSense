import uuid
import time
import logging
from datetime import datetime, timedelta

from core.database import get_db

logger = logging.getLogger(__name__)


def _sessions():
    return get_db()["sessions"]


_user_cache = {}

_track_alert_state = {}

_ALERT_RANK = {"none": 0, "low": 1, "high": 2}

_ALERT_STATE_TTL = 5.0


def get_cached_state(user_id: str) -> dict:
    return _user_cache.get(user_id, {})


def update_cache(user_id: str, **kwargs):
    if user_id not in _user_cache:
        _user_cache[user_id] = {}
    _user_cache[user_id].update(kwargs)


def clear_cache(user_id: str):
    _user_cache.pop(user_id, None)
    _track_alert_state.pop(user_id, None)
    _ws_tracked.pop(user_id, None)
    _ws_had_engaged.pop(user_id, None)
    try:
        get_db()["users"].update_one(
            {"user_id": user_id},
            {"$set": {"last_seen": datetime.now().isoformat()}},
        )
    except Exception as e:
        logger.error(f"Failed to stamp last_seen for {user_id}: {e}")



def get_online_user_ids() -> set:
    return set(_user_cache.keys())


def is_user_online(user_id: str) -> bool:
    return user_id in _user_cache



def get_or_create_session(user_id: str) -> str:
    sessions = _sessions()

    existing = sessions.find_one({"user_id": user_id, "status": "active"})
    if existing:
        logger.info(f"Resuming active session: {existing['session_id']}, user={user_id}")
        return existing["session_id"]

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
    _sessions().update_one(
        {"session_id": session_id, "status": "active"},
        {"$set": {"status": "stopped", "stopped_at": datetime.now().isoformat()}}
    )
    logger.info(f"Session stopped: {session_id}")


def get_active_session(user_id: str) -> dict | None:
    return _sessions().find_one({"user_id": user_id, "status": "active"})


_PRESENCE_TTL = 1.5

_STATIC_CONFIRM_SEC = 0.8

_ws_tracked = {}
_ws_had_engaged = {}


def evaluate_presence(user_id: str, objects: list[dict]) -> dict:
    now = time.monotonic()
    tracks = _ws_tracked.setdefault(user_id, {})
    notice = None

    for obj in objects or []:
        if not obj.get("watched"):
            continue
        track_id = obj.get("motion", {}).get("track_id", -1)
        if track_id < 0:
            continue
        if obj.get("distance") == "Far":
            continue

        st = tracks.setdefault(track_id, {
            "static_since": None, "announced": False, "engaged": False,
        })
        st["seen"] = now
        st["class_name"] = obj.get("class_name")
        st["position"] = obj.get("position")

        moving = (obj.get("motion", {}).get("approaching", False)
                  or obj.get("alert_level", "none") != "none")

        if moving:
            st["static_since"] = None
            st["announced"] = False
            st["engaged"] = True
        else:
            if st["static_since"] is None:
                st["static_since"] = now
            elif (now - st["static_since"] >= _STATIC_CONFIRM_SEC) and not st["announced"]:
                st["announced"] = True
                st["engaged"] = True
                if notice is None:
                    notice = {
                        "class_name": st["class_name"],
                        "position": st["position"],
                    }

    for stale in [t for t, st in tracks.items() if now - st.get("seen", 0) > _PRESENCE_TTL]:
        del tracks[stale]

    any_engaged = any(st.get("engaged") for st in tracks.values())
    had = _ws_had_engaged.get(user_id, False)
    danger_cleared = False
    if any_engaged:
        _ws_had_engaged[user_id] = True
    elif had:
        _ws_had_engaged[user_id] = False
        danger_cleared = True

    return {"danger_cleared": danger_cleared, "static_notice": notice}


def has_new_alert(user_id: str, objects: list[dict]) -> bool:
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

    for stale_id in [t for t, s in state.items() if now - s["seen"] > _ALERT_STATE_TTL]:
        del state[stale_id]

    return is_new



def save_frame_count_background(session_id: str, frame_count: int):
    from services import db_writer
    db_writer.note_frame_count(session_id, frame_count)