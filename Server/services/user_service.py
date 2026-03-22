import uuid
import bcrypt
import logging
from datetime import datetime
from typing import Optional

from core.database import get_db

logger = logging.getLogger(__name__)


def _users():
    return get_db()["users"]

def _feedback():
    return get_db()["feedback"]

def _detection_history():
    return get_db()["detection_history"]


# ==================== User CRUD ====================

def create_user(data: dict) -> dict:
    """Register a new user. Returns the created profile."""
    user_id = str(uuid.uuid4())[:8]

    # Check duplicate email
    if _users().find_one({"email": data["email"]}):
        raise ValueError(f"Email {data['email']} already registered")

    profile = {
        "user_id": user_id,
        "name": data["name"],
        "email": data["email"],
        "phone": data["phone"],
        "password_hash": _hash_password(data["password"]),
        "country": data.get("country"),
        "date_of_birth": data.get("date_of_birth"),
        "height_cm": data.get("height_cm"),
        "weight_kg": data.get("weight_kg"),
        "emergency_contact": data.get("emergency_contact"),
        "created_at": datetime.now().isoformat()
    }

    _users().insert_one(profile)
    logger.info(f"User created: {user_id} ({data['name']})")
    return _safe_profile(profile)


def get_user(user_id: str) -> Optional[dict]:
    """Fetch user profile by ID."""
    profile = _users().find_one({"user_id": user_id})
    if not profile:
        return None
    return _safe_profile(profile)


def update_user(user_id: str, updates: dict) -> Optional[dict]:
    """Update user profile fields."""
    allowed_fields = {"name", "phone", "date_of_birth", "height_cm", "weight_kg", "emergency_contact"}
    filtered = {k: v for k, v in updates.items() if k in allowed_fields}

    if not filtered:
        return get_user(user_id)

    result = _users().update_one({"user_id": user_id}, {"$set": filtered})
    if result.matched_count == 0:
        return None

    logger.info(f"User updated: {user_id}")
    return get_user(user_id)


def authenticate_user(email: str, password: str) -> Optional[dict]:
    """Find user by email and verify password with bcrypt."""
    profile = _users().find_one({"email": email})
    if not profile:
        return None

    if _verify_password(password, profile["password_hash"]):
        logger.info(f"User authenticated: {profile['user_id']}")
        return _safe_profile(profile)
    return None


def get_user_by_email(email: str) -> Optional[dict]:
    """Fetch user profile by email."""
    profile = _users().find_one({"email": email})
    if not profile:
        return None
    return _safe_profile(profile)


def change_password(user_id: str, old_password: str, new_password: str, force: bool = False) -> bool:
    """
    Change user password.
    If force=True, skip old password check (for password reset).
    Returns True if successful.
    """
    profile = _users().find_one({"user_id": user_id})
    if not profile:
        return False

    # Verify old password unless forced (reset flow)
    if not force:
        if not _verify_password(old_password, profile["password_hash"]):
            return False

    new_hash = _hash_password(new_password)
    _users().update_one({"user_id": user_id}, {"$set": {"password_hash": new_hash}})
    logger.info(f"Password changed for user: {user_id}")
    return True


# ==================== Detection History ====================

def add_detection_record(user_id: str, record: dict):
    """Store a detection result in user history."""
    entry = {
        "user_id": user_id,
        "timestamp": datetime.now().isoformat(),
        "danger": record.get("danger", False),
        "alert_level": record.get("alert_level", "none"),
        "distance": record.get("distance", "Far"),
        "objects_detected": len(record.get("objects", []))
    }
    _detection_history().insert_one(entry)


def get_user_history(user_id: str, limit: int = 50) -> list[dict]:
    """Retrieve detection history for a user."""
    cursor = _detection_history().find(
        {"user_id": user_id},
        {"_id": 0}
    ).sort("timestamp", -1).limit(limit)
    return list(cursor)

def delete_detection_record(user_id: str, timestamp: str) -> bool:
    """Delete a single detection record by timestamp."""
    result = _detection_history().delete_one({"user_id": user_id, "timestamp": timestamp})
    return result.deleted_count > 0


def clear_user_history(user_id: str) -> int:
    """Delete all detection history for a user. Returns count deleted."""
    result = _detection_history().delete_many({"user_id": user_id})
    logger.info(f"Cleared {result.deleted_count} history records for user: {user_id}")
    return result.deleted_count


# ==================== Feedback ====================

def add_feedback(user_id: str, feedback: dict):
    """Store user feedback on detection quality."""
    entry = {
        "user_id": user_id,
        "timestamp": datetime.now().isoformat(),
        "session_id": feedback.get("session_id"),
        "feedback_type": feedback.get("feedback_type"),
        "notes": feedback.get("notes")
    }
    _feedback().insert_one(entry)
    logger.info(f"Feedback received from {user_id}: {feedback.get('feedback_type')}")


# ==================== Emergency ====================

def trigger_emergency(user_id: str, gps_lat: float, gps_lon: float, message: str) -> dict:
    """
    Trigger emergency alert — sends location to emergency contact.
    POC: returns the alert payload. Production: integrate SMS via Twilio.
    """
    profile = _users().find_one({"user_id": user_id})
    if not profile:
        raise ValueError("User not found")

    contact = profile.get("emergency_contact")
    if not contact:
        raise ValueError("No emergency contact configured")

    alert = {
        "user_id": user_id,
        "user_name": profile["name"],
        "contact_name": contact["name"],
        "contact_phone": contact["phone"],
        "gps": {"lat": gps_lat, "lon": gps_lon},
        "google_maps_link": f"https://maps.google.com/?q={gps_lat},{gps_lon}",
        "message": message,
        "timestamp": datetime.now().isoformat()
    }

    # TODO: Send actual SMS here (Twilio / other service)
    logger.warning(f"EMERGENCY ALERT: {alert}")
    return alert


# ==================== Helpers ====================

def _hash_password(password: str) -> bytes:
    """Hash password using bcrypt."""
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt())


def _verify_password(password: str, hashed: bytes) -> bool:
    """Verify password against bcrypt hash."""
    return bcrypt.checkpw(password.encode("utf-8"), hashed)


def _safe_profile(profile: dict) -> dict:
    """Return profile without password hash and MongoDB _id."""
    return {k: v for k, v in profile.items() if k not in ("password_hash", "_id")}