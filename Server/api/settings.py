from fastapi import APIRouter, HTTPException
import logging
from fastapi import Depends
from core.auth import verify_token
from core.config import DEFAULT_SETTINGS

from core.config import ALL_CLASSES
from core.database import get_db
from services.session_service import update_cache

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/settings", tags=["Settings"])


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
def get_settings(current_user: dict = Depends(verify_token)):
    """Retrieve user preferences."""
    user_id = current_user["user_id"]
    settings = get_user_settings(user_id)
    logger.info(f"Fetched settings for user: {user_id}")
    return {"status": "success", "user_id": user_id, "settings": settings}


@router.post("/update_settings")
def update_settings(settings: dict = {}, current_user: dict = Depends(verify_token)):
    """Update user preferences."""
    user_id = current_user["user_id"]
    valid_keys = DEFAULT_SETTINGS.keys()

    for key, value in settings.items():
        if key not in valid_keys:
            raise HTTPException(status_code=400, detail=f"Invalid setting: {key}")

        if key == "high_risk_classes":
            if not isinstance(value, list):
                raise HTTPException(status_code=400, detail="high_risk_classes must be a list")
            invalid = set(value) - ALL_CLASSES
            if invalid:
                raise HTTPException(status_code=400, detail=f"Invalid classes: {invalid}. Choose from: {sorted(ALL_CLASSES)}")

        if key == "detection_sensitivity":
            if value not in ("low", "medium", "high"):
                raise HTTPException(status_code=400, detail=f"Invalid sensitivity: {value}. Choose from: low, medium, high")

        if key == "alert_type":
            if value not in ("audio", "haptic", "both"):
                raise HTTPException(status_code=400, detail=f"Invalid alert_type: {value}. Choose from: audio, haptic, both")

        if key == "voice_gender":
            if value not in ("female", "male", "default"):
                raise HTTPException(status_code=400, detail=f"Invalid voice_gender: {value}. Choose from: female, male, default")

        if key in ("volume_intensity", "vibration_intensity"):
            if not isinstance(value, (int, float)) or not (0.0 <= value <= 1.0):
                raise HTTPException(status_code=400, detail=f"{key} must be a number between 0.0 and 1.0")

    _settings_collection().update_one(
        {"user_id": user_id},
        {"$set": {**settings, "user_id": user_id}},
        upsert=True
    )

    updated = get_user_settings(user_id)
    update_cache(user_id, settings=updated)
    logger.info(f"Updated settings for user: {user_id} → {settings}")
    return {"status": "success", "user_id": user_id, "settings": updated}


@router.get("/available_classes")
def get_available_classes(current_user: dict = Depends(verify_token)):
    """Returns all classes the user can choose from."""
    return {
        "status": "success",
        "classes": sorted(list(ALL_CLASSES))
    }


@router.post("/reset_settings")
def reset_settings(current_user: dict = Depends(verify_token)):
    """Restore all settings to default."""
    user_id = current_user["user_id"]
    _settings_collection().update_one(
        {"user_id": user_id},
        {"$set": {**DEFAULT_SETTINGS, "user_id": user_id}},
        upsert=True
    )

    logger.info(f"Reset settings for user: {user_id}")
    return {"status": "success", "user_id": user_id, "settings": DEFAULT_SETTINGS}