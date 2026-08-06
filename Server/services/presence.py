"""
In-memory presence tracking — "who is currently using the app".

A user is considered ONLINE if they have made any authenticated activity within
the last ONLINE_THRESHOLD_SECONDS. Activity is stamped from:
  - any authenticated HTTP request (via core.auth.verify_token),
  - a periodic client heartbeat while the app is open (POST /users/heartbeat),
  - the streaming WebSocket (connect + ongoing frames/rtt reports).

This is deliberately NOT tied to the scanning WebSocket alone — a logged-in user
browsing the app (e.g. the admin dashboard) should read as online even when they
aren't actively scanning the camera.

In-memory only (single worker): resets on server restart, at which point everyone
reads offline until their next request/heartbeat. `last_seen` in the DB still
provides the "offline since X" timestamp across restarts.
"""

import time

# user_id -> last activity epoch seconds
_last_active: dict[str, float] = {}

ONLINE_THRESHOLD_SECONDS = 90  # ~3 missed 30s heartbeats


def mark_active(user_id: str):
    if user_id:
        _last_active[user_id] = time.time()


def is_online(user_id: str) -> bool:
    ts = _last_active.get(user_id)
    return ts is not None and (time.time() - ts) < ONLINE_THRESHOLD_SECONDS


def get_online_user_ids() -> set:
    now = time.time()
    return {uid for uid, ts in _last_active.items() if now - ts < ONLINE_THRESHOLD_SECONDS}

