from fastapi import APIRouter, HTTPException
import logging
import uuid
from datetime import datetime

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/stream", tags=["Stream"])

# Active sessions storage (in-memory for POC)
active_sessions = {}


@router.post("/start_stream")
async def start_stream(user_id: str = "default"):
    """
    Initialize a continuous video streaming session.
    Returns a session_id the client uses for subsequent requests.
    """
    # Check if user already has an active session
    for session_id, session in active_sessions.items():
        if session["user_id"] == user_id and session["status"] == "active":
            logger.warning(f"User {user_id} already has active session: {session_id}")
            return {
                "status": "already_active",
                "session_id": session_id,
                "message": "Session already running"
            }

    session_id = str(uuid.uuid4())
    active_sessions[session_id] = {
        "user_id": user_id,
        "status": "active",
        "started_at": datetime.now().isoformat(),
        "frame_count": 0
    }

    logger.info(f"Stream started: session={session_id}, user={user_id}")
    return {
        "status": "success",
        "session_id": session_id,
        "message": "Stream session started"
    }


@router.post("/stop_stream")
async def stop_stream(session_id: str):
    """Terminate an ongoing video analysis session."""
    if session_id not in active_sessions:
        raise HTTPException(status_code=404, detail="Session not found")

    session = active_sessions[session_id]
    if session["status"] == "stopped":
        raise HTTPException(status_code=400, detail="Session already stopped")

    session["status"] = "stopped"
    session["stopped_at"] = datetime.now().isoformat()

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
    if session_id not in active_sessions:
        raise HTTPException(status_code=404, detail="Session not found")

    session = active_sessions[session_id]
    if session["status"] != "active":
        raise HTTPException(status_code=400, detail="Session is not active")

    # TODO: Return latest detection result from this session
    # For now returns empty — will be populated when connected to real-time pipeline
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