from fastapi import APIRouter, HTTPException
import logging

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/settings", tags=["Settings"])

# In-memory storage for POC (replace with DB later)
user_settings = {
    "default": {
        "alert_type": "both",            # "audio" | "haptic" | "both"
        "volume_intensity": 0.8,          # 0.0 - 1.0
        "vibration_intensity": 0.8,       # 0.0 - 1.0
        "detection_sensitivity": "medium" # "low" | "medium" | "high"
    }
}

DEFAULT_SETTINGS = {
    "alert_type": "both",
    "volume_intensity": 0.8,
    "vibration_intensity": 0.8,
    "detection_sensitivity": "medium"
}


@router.get("/get_settings")
async def get_settings(user_id: str = "default"):
    """Retrieve user preferences."""
    settings = user_settings.get(user_id)
    if not settings:
        raise HTTPException(status_code=404, detail="User not found")

    logger.info(f"Fetched settings for user: {user_id}")
    return {"status": "success", "user_id": user_id, "settings": settings}


@router.post("/update_settings")
async def update_settings(user_id: str = "default", settings: dict = {}):
    """Update user preferences."""
    valid_keys = DEFAULT_SETTINGS.keys()

    if user_id not in user_settings:
        user_settings[user_id] = DEFAULT_SETTINGS.copy()

    for key, value in settings.items():
        if key not in valid_keys:
            raise HTTPException(status_code=400, detail=f"Invalid setting: {key}")
        user_settings[user_id][key] = value

    logger.info(f"Updated settings for user: {user_id} → {settings}")
    return {"status": "success", "user_id": user_id, "settings": user_settings[user_id]}


@router.post("/reset_settings")
async def reset_settings(user_id: str = "default"):
    """Restore all settings to default."""
    user_settings[user_id] = DEFAULT_SETTINGS.copy()

    logger.info(f"Reset settings for user: {user_id}")
    return {"status": "success", "user_id": user_id, "settings": user_settings[user_id]}