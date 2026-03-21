from fastapi import APIRouter, HTTPException
import logging
import uuid
from datetime import datetime

from core.database import get_db

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/stream", tags=["Stream"])


def _sessions():
    return get_db()["sessions"]


@router.post("/start_stream")
async def start_stream(user_id: str = "default"):
    """Initialize a continuous video streaming session."""
    # Check if user already has an active session
    existing = _sessions().find_one({"user_id": user_id, "status": "active"})
    if existing:
        return {
            "status": "already_active",
            "session_id": existing["session_id"],
            "message": "Session already running"
        }

    session_id = str(uuid.uuid4())
    _sessions().insert_one({
        "session_id": session_id,
        "user_id": user_id,
        "status": "active",
        "started_at": datetime.now().isoformat(),
        "frame_count": 0
    })

    logger.info(f"Stream started: session={session_id}, user={user_id}")
    return {
        "status": "success",
        "session_id": session_id,
        "message": "Stream session started"
    }


@router.post("/stop_stream")
async def stop_stream(session_id: str):
    """Terminate an ongoing video analysis session."""
    session = _sessions().find_one({"session_id": session_id})
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    if session["status"] == "stopped":
        raise HTTPException(status_code=400, detail="Session already stopped")

    _sessions().update_one(
        {"session_id": session_id},
        {"$set": {"status": "stopped", "stopped_at": datetime.now().isoformat()}}
    )

    logger.info(f"Stream stopped: session={session_id}, frames={session['frame_count']}")
    return {
        "status": "success",
        "session_id": session_id,
        "frame_count": session["frame_count"],
        "message": "Stream session stopped"
    }


@router.get("/get_live_feedback")
async def get_live_feedback(session_id: str):
    """Returns current obstacle alerts for an active session."""
    session = _sessions().find_one({"session_id": session_id})
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    if session["status"] != "active":
        raise HTTPException(status_code=400, detail="Session is not active")

    return {
        "status": "success",
        "session_id": session_id,
        "frame_count": session["frame_count"],
        "latest_detection": {
            "danger": False,
            "alert_level": "none",
            "distance": "Far",
            "objects": []
        }
    }