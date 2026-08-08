
import time

_last_active: dict[str, float] = {}

ONLINE_THRESHOLD_SECONDS = 90


def mark_active(user_id: str):
    if user_id:
        _last_active[user_id] = time.time()


def is_online(user_id: str) -> bool:
    ts = _last_active.get(user_id)
    return ts is not None and (time.time() - ts) < ONLINE_THRESHOLD_SECONDS


def get_online_user_ids() -> set:
    now = time.time()
    return {uid for uid, ts in _last_active.items() if now - ts < ONLINE_THRESHOLD_SECONDS}

