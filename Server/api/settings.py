from fastapi import APIRouter, HTTPException
import logging
from fastapi import Depends
from core.auth import verify_token

from core.config import ALL_CLASSES, HIGH_RISK_CLASSES
from core.database import get_db

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/settings", tags=["Settings"])

DEFAULT_SETTINGS = {
    "alert_type": "both",
    "volume_intensity": 0.8,
    "vibration_intensity": 0.8,
    "detection_sensitivity": "medium",
    "high_risk_classes": list(HIGH_RISK_CLASSES)
}


def _settings_collection():
    return get_db()["settings"]


def get_user_settings(user_id: str) -> dict:
    """Get settings for a user. Returns defaults if not found."""
    doc = _settings_collection().find_one({"user_id": user_id}, {"_id": 0})
    if not doc:
        return DEFAULT_SETTINGS.copy()
    settings = {k: v for k, v in doc.items() if k != "user_id"}
    return settings


@router.get("/get_settings")
async def get_settings(current_user: dict = Depends(verify_token)):
    """Retrieve user preferences."""
    user_id = current_user["user_id"]
    settings = get_user_settings(user_id)
    logger.info(f"Fetched settings for user: {user_id}")
    return {"status": "success", "user_id": user_id, "settings": settings}


@router.post("/update_settings")
async def update_settings(settings: dict = {}, current_user: dict = Depends(verify_token)):
    """Update user preferences."""
    user_id = current_user["user_id"]
    valid_keys = DEFAULT_SETTINGS.keys()

    for key, value in settings.items():
        if key not in valid_keys:
            raise HTTPException(status_code=400, detail=f"Invalid setting: {key}")

        # Validate high_risk_classes
        if key == "high_risk_classes":
            if not isinstance(value, list):
                raise HTTPException(status_code=400, detail="high_risk_classes must be a list")
            invalid = set(value) - ALL_CLASSES
            if invalid:
                raise HTTPException(status_code=400, detail=f"Invalid classes: {invalid}. Choose from: {sorted(ALL_CLASSES)}")

        # Validate detection_sensitivity
        if key == "detection_sensitivity":
            if value not in ("low", "medium", "high"):
                raise HTTPException(status_code=400, detail=f"Invalid sensitivity: {value}. Choose from: low, medium, high")

        # Validate alert_type
        if key == "alert_type":
            if value not in ("audio", "haptic", "both"):
                raise HTTPException(status_code=400, detail=f"Invalid alert_type: {value}. Choose from: audio, haptic, both")

        # Validate intensity values
        if key in ("volume_intensity", "vibration_intensity"):
            if not isinstance(value, (int, float)) or not (0.0 <= value <= 1.0):
                raise HTTPException(status_code=400, detail=f"{key} must be a number between 0.0 and 1.0")

    # Upsert — create if not exists, update if exists
    _settings_collection().update_one(
        {"user_id": user_id},
        {"$set": {**settings, "user_id": user_id}},
        upsert=True
    )

    updated = get_user_settings(user_id)
    logger.info(f"Updated settings for user: {user_id} → {settings}")
    return {"status": "success", "user_id": user_id, "settings": updated}


@router.get("/available_classes")
async def get_available_classes(current_user: dict = Depends(verify_token)):
    """Returns all classes the user can choose from."""
    user_id = current_user["user_id"]
    return {
        "status": "success",
        "classes": sorted(list(ALL_CLASSES))
    }


@router.post("/reset_settings")
async def reset_settings(current_user: dict = Depends(verify_token)):
    """Restore all settings to default."""
    user_id = current_user["user_id"]
    _settings_collection().update_one(
        {"user_id": user_id},
        {"$set": {**DEFAULT_SETTINGS, "user_id": user_id}},
        upsert=True
    )

    logger.info(f"Reset settings for user: {user_id}")
    return {"status": "success", "user_id": user_id, "settings": DEFAULT_SETTINGS}