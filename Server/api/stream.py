from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel
import logging
import uuid
from datetime import datetime, timedelta

from core.auth import verify_token
from core.database import get_db

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/stream", tags=["Stream"])


class StopStreamRequest(BaseModel):
    session_id: str


class LiveFeedbackRequest(BaseModel):
    session_id: str


def _sessions():
    return get_db()["sessions"]


@router.post("/start_stream")
async def start_stream(current_user: dict = Depends(verify_token)):
    """Initialize or resume a video streaming session."""
    user_id = current_user["user_id"]

    # Check if already has an active session
    existing = _sessions().find_one({"user_id": user_id, "status": "active"})
    if existing:
        return {
            "status": "already_active",
            "session_id": existing["session_id"],
            "message": "Session already running"
        }

    # Check if there's a recently stopped session (within 15 minutes)
    cutoff = (datetime.now() - timedelta(minutes=15)).isoformat()
    recent = _sessions().find_one({
        "user_id": user_id,
        "status": "stopped",
        "stopped_at": {"$gte": cutoff}
    })

    if recent:
        # Reactivate the recent session
        _sessions().update_one(
            {"session_id": recent["session_id"]},
            {"$set": {"status": "active", "paused": False}, "$unset": {"stopped_at": ""}}
        )
        logger.info(f"Stream resumed: session={recent['session_id']}, user={user_id}")
        return {
            "status": "resumed",
            "session_id": recent["session_id"],
            "frame_count": recent["frame_count"],
            "message": "Previous session resumed"
        }

    # Create new session
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
async def stop_stream(request: StopStreamRequest, current_user: dict = Depends(verify_token)):
    """Terminate an ongoing video analysis session."""
    user_id = current_user["user_id"]
    session = _sessions().find_one({"session_id": request.session_id, "user_id": user_id})

    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    if session["status"] == "stopped":
        raise HTTPException(status_code=400, detail="Session already stopped")

    _sessions().update_one(
        {"session_id": request.session_id},
        {"$set": {"status": "stopped", "stopped_at": datetime.now().isoformat(), "paused": False}}
    )

    logger.info(f"Stream stopped: session={request.session_id}, frames={session['frame_count']}")
    return {
        "status": "success",
        "session_id": request.session_id,
        "frame_count": session["frame_count"],
        "message": "Stream session stopped"
    }


@router.get("/session_status")
async def session_status(current_user: dict = Depends(verify_token)):
    """Returns current session status — active/paused, frame count, duration."""
    user_id = current_user["user_id"]
    session = _sessions().find_one({"user_id": user_id, "status": "active"})

    if not session:
        return {
            "status": "success",
            "session": None,
            "message": "No active session"
        }

    return {
        "status": "success",
        "session": {
            "session_id": session["session_id"],
            "started_at": session["started_at"],
            "frame_count": session["frame_count"],
            "paused": session.get("paused", False)
        }
    }