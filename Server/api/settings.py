from fastapi import APIRouter, HTTPException
import logging

from core.config import ALL_CLASSES, HIGH_RISK_CLASSES

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/settings", tags=["Settings"])

# In-memory storage for POC (replace with DB later)
user_settings = {
    "default": {
        "alert_type": "both",            # "audio" | "haptic" | "both"
        "volume_intensity": 0.8,          # 0.0 - 1.0
        "vibration_intensity": 0.8,       # 0.0 - 1.0
        "detection_sensitivity": "medium", # "low" | "medium" | "high"
        "high_risk_classes": list(HIGH_RISK_CLASSES)
    }
}

DEFAULT_SETTINGS = {
    "alert_type": "both",
    "volume_intensity": 0.8,
    "vibration_intensity": 0.8,
    "detection_sensitivity": "medium",
    "high_risk_classes": list(HIGH_RISK_CLASSES)
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

        # Validate high_risk_classes — must be from ALL_CLASSES
        if key == "high_risk_classes":
            if not isinstance(value, list):
                raise HTTPException(status_code=400, detail="high_risk_classes must be a list")
            invalid = set(value) - ALL_CLASSES
            if invalid:
                raise HTTPException(status_code=400, detail=f"Invalid classes: {invalid}. Choose from: {sorted(ALL_CLASSES)}")

        user_settings[user_id][key] = value

    logger.info(f"Updated settings for user: {user_id} → {settings}")
    return {"status": "success", "user_id": user_id, "settings": user_settings[user_id]}


@router.get("/available_classes")
async def get_available_classes():
    """Returns all classes the user can choose from."""
    return {
        "status": "success",
        "classes": sorted(list(ALL_CLASSES))
    }


@router.post("/reset_settings")
async def reset_settings(user_id: str = "default"):
    """Restore all settings to default."""
    user_settings[user_id] = DEFAULT_SETTINGS.copy()

    logger.info(f"Reset settings for user: {user_id}")
    return {"status": "success", "user_id": user_id, "settings": user_settings[user_id]}