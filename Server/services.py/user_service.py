import uuid
import bcrypt
import logging
from datetime import datetime
from typing import Optional

logger = logging.getLogger(__name__)

# ============================================================
# In-memory storage for POC
# Replace these dicts with DB queries when moving to production
# ============================================================

_users = {}              # user_id → user profile dict
_feedback = {}           # user_id → list of feedback entries
_detection_history = {}  # user_id → list of detection records


# ==================== User CRUD ====================

def create_user(data: dict) -> dict:
    """Register a new user. Returns the created profile."""
    user_id = str(uuid.uuid4())[:8]

    # Check duplicate email
    for existing in _users.values():
        if existing["email"] == data["email"]:
            raise ValueError(f"Email {data['email']} already registered")

    profile = {
        "user_id": user_id,
        "name": data["name"],
        "email": data["email"],
        "phone": data["phone"],
        "password_hash": _hash_password(data["password"]),
        "date_of_birth": data.get("date_of_birth"),
        "height_cm": data.get("height_cm"),
        "weight_kg": data.get("weight_kg"),
        "emergency_contact": data.get("emergency_contact"),
        "created_at": datetime.now().isoformat()
    }

    _users[user_id] = profile
    logger.info(f"User created: {user_id} ({data['name']})")
    return _safe_profile(profile)


def get_user(user_id: str) -> Optional[dict]:
    """Fetch user profile by ID."""
    profile = _users.get(user_id)
    if not profile:
        return None
    return _safe_profile(profile)


def update_user(user_id: str, updates: dict) -> Optional[dict]:
    """Update user profile fields."""
    if user_id not in _users:
        return None

    allowed_fields = {"name", "phone", "date_of_birth", "height_cm", "weight_kg", "emergency_contact"}
    for key, value in updates.items():
        if key in allowed_fields:
            _users[user_id][key] = value

    logger.info(f"User updated: {user_id}")
    return _safe_profile(_users[user_id])


def authenticate_user(email: str, password: str) -> Optional[dict]:
    """Find user by email and verify password with bcrypt."""
    for profile in _users.values():
        if profile["email"] == email:
            if _verify_password(password, profile["password_hash"]):
                logger.info(f"User authenticated: {profile['user_id']}")
                return _safe_profile(profile)
            return None
    return None


# ==================== Detection History ====================

def add_detection_record(user_id: str, record: dict):
    """Store a detection result in user history."""
    if user_id not in _detection_history:
        _detection_history[user_id] = []

    entry = {
        "timestamp": datetime.now().isoformat(),
        "danger": record.get("danger", False),
        "alert_level": record.get("alert_level", "none"),
        "distance": record.get("distance", "Far"),
        "objects_detected": len(record.get("objects", []))
    }

    _detection_history[user_id].append(entry)

    # Keep last 500 records per user
    if len(_detection_history[user_id]) > 500:
        _detection_history[user_id] = _detection_history[user_id][-500:]


def get_user_history(user_id: str, limit: int = 50) -> list[dict]:
    """Retrieve detection history for a user."""
    history = _detection_history.get(user_id, [])
    return history[-limit:]


# ==================== Feedback ====================

def add_feedback(user_id: str, feedback: dict):
    """Store user feedback on detection quality."""
    if user_id not in _feedback:
        _feedback[user_id] = []

    entry = {
        "timestamp": datetime.now().isoformat(),
        "session_id": feedback.get("session_id"),
        "feedback_type": feedback.get("feedback_type"),
        "notes": feedback.get("notes")
    }

    _feedback[user_id].append(entry)
    logger.info(f"Feedback received from {user_id}: {feedback.get('feedback_type')}")


# ==================== Emergency ====================

def trigger_emergency(user_id: str, gps_lat: float, gps_lon: float, message: str) -> dict:
    """
    Trigger emergency alert — sends location to emergency contact.
    POC: returns the alert payload. Production: integrate SMS via Twilio.
    """
    profile = _users.get(user_id)
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
    """Return profile without password hash."""
    return {k: v for k, v in profile.items() if k != "password_hash"}