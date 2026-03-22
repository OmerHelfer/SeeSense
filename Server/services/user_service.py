import uuid
import bcrypt
import logging
import random
import string
from datetime import datetime, timedelta
from typing import Optional

from core.database import get_db

logger = logging.getLogger(__name__)


def _users():
    return get_db()["users"]

def _feedback():
    return get_db()["feedback"]

def _detection_history():
    return get_db()["detection_history"]

def _emergency_contacts():
    return get_db()["emergency_contacts"]

MAX_EMERGENCY_CONTACTS = 5
CONTACT_CODE_EXPIRY_MINUTES = 30
MAX_CODE_ATTEMPTS = 3


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
    allowed_fields = {"name", "phone", "country", "date_of_birth", "height_cm", "weight_kg"}
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

def add_detection_record(user_id: str, record: dict) -> str:
    """Store a detection result in user history. Returns record ID."""
    entry = {
        "user_id": user_id,
        "timestamp": datetime.now().isoformat(),
        "danger": record.get("danger", False),
        "alert_level": record.get("alert_level", "none"),
        "distance": record.get("distance", "Far"),
        "objects_detected": len(record.get("objects", []))
    }
    result = _detection_history().insert_one(entry)
    return str(result.inserted_id)


def get_user_history(user_id: str, limit: int = 50) -> list[dict]:
    """Retrieve detection history for a user."""
    cursor = _detection_history().find(
        {"user_id": user_id}
    ).sort("timestamp", -1).limit(limit)

    results = []
    for doc in cursor:
        doc["record_id"] = str(doc["_id"])
        del doc["_id"]
        del doc["user_id"]
        results.append(doc)
    return results


def delete_detection_record(user_id: str, record_id: str) -> bool:
    """Delete a single detection record by ID."""
    from bson import ObjectId
    result = _detection_history().delete_one({"_id": ObjectId(record_id), "user_id": user_id})
    return result.deleted_count > 0


def clear_user_history(user_id: str) -> int:
    """Delete all detection history for a user. Returns count deleted."""
    result = _detection_history().delete_many({"user_id": user_id})
    logger.info(f"Cleared {result.deleted_count} history records for user: {user_id}")
    return result.deleted_count


# ==================== Feedback ====================

def create_quick_feedback(user_id: str, feedback_type: str, record_id: str = None) -> str:
    """
    Quick feedback from user during walk — no notes, status is pending.
    Companion can add notes later.
    Returns feedback ID.
    """
    entry = {
        "user_id": user_id,
        "feedback_type": feedback_type,
        "record_id": record_id,
        "notes": None,
        "status": "pending",
        "created_at": datetime.now().isoformat(),
        "updated_at": None
    }
    result = _feedback().insert_one(entry)
    logger.info(f"Quick feedback from {user_id}: {feedback_type}")
    return str(result.inserted_id)


def create_feedback_from_history(user_id: str, record_id: str, feedback_type: str, notes: str = None) -> str:
    """
    Companion creates feedback from a specific history record.
    Returns feedback ID.
    """
    entry = {
        "user_id": user_id,
        "feedback_type": feedback_type,
        "record_id": record_id,
        "notes": notes,
        "status": "submitted" if notes else "pending",
        "created_at": datetime.now().isoformat(),
        "updated_at": None
    }
    result = _feedback().insert_one(entry)
    logger.info(f"Feedback from history for {user_id}: {feedback_type} on record {record_id}")
    return str(result.inserted_id)


def create_standalone_feedback(user_id: str, feedback_type: str, notes: str = None) -> str:
    """
    Standalone feedback — not linked to any specific detection.
    Returns feedback ID.
    """
    entry = {
        "user_id": user_id,
        "feedback_type": feedback_type,
        "record_id": None,
        "notes": notes,
        "status": "submitted" if notes else "pending",
        "created_at": datetime.now().isoformat(),
        "updated_at": None
    }
    result = _feedback().insert_one(entry)
    logger.info(f"Standalone feedback from {user_id}: {feedback_type}")
    return str(result.inserted_id)


def get_pending_feedback(user_id: str) -> list[dict]:
    """Get all pending feedback for a user (waiting for companion notes)."""
    cursor = _feedback().find(
        {"user_id": user_id, "status": "pending"}
    ).sort("created_at", -1)

    results = []
    for doc in cursor:
        doc["feedback_id"] = str(doc["_id"])
        del doc["_id"]
        del doc["user_id"]
        results.append(doc)
    return results


def get_all_feedback(user_id: str) -> list[dict]:
    """Get all feedback for a user."""
    cursor = _feedback().find(
        {"user_id": user_id}
    ).sort("created_at", -1)

    results = []
    for doc in cursor:
        doc["feedback_id"] = str(doc["_id"])
        del doc["_id"]
        del doc["user_id"]
        results.append(doc)
    return results


def update_feedback(user_id: str, feedback_id: str, notes: str = None, feedback_type: str = None) -> dict:
    """
    Companion updates a pending feedback — adds notes and/or changes type.
    Automatically marks as submitted.
    """
    from bson import ObjectId

    updates = {"status": "submitted", "updated_at": datetime.now().isoformat()}
    if notes is not None:
        updates["notes"] = notes
    if feedback_type is not None:
        updates["feedback_type"] = feedback_type

    result = _feedback().find_one_and_update(
        {"_id": ObjectId(feedback_id), "user_id": user_id},
        {"$set": updates},
        return_document=True
    )

    if not result:
        return None

    result["feedback_id"] = str(result["_id"])
    del result["_id"]
    del result["user_id"]
    return result


def submit_feedback(user_id: str, feedback_id: str) -> bool:
    """Submit a pending feedback as-is (without adding notes)."""
    from bson import ObjectId
    result = _feedback().update_one(
        {"_id": ObjectId(feedback_id), "user_id": user_id, "status": "pending"},
        {"$set": {"status": "submitted", "updated_at": datetime.now().isoformat()}}
    )
    return result.modified_count > 0


def delete_feedback(user_id: str, feedback_id: str) -> bool:
    """Delete a feedback entry."""
    from bson import ObjectId
    result = _feedback().delete_one({"_id": ObjectId(feedback_id), "user_id": user_id})
    return result.deleted_count > 0


# ==================== Emergency Contacts ====================

def add_emergency_contact(user_id: str, name: str, phone: str, email: str) -> dict:
    """
    Add a new emergency contact. Sends verification code to their email.
    Contact stays pending until verified.
    """

    profile = _users().find_one({"user_id": user_id})
    if not profile:
        raise ValueError("User not found")

    # Edge case: can't add yourself
    if email == profile["email"]:
        raise ValueError("Cannot add yourself as an emergency contact")

    # Edge case: max contacts reached
    existing_count = _emergency_contacts().count_documents({"user_id": user_id})
    if existing_count >= MAX_EMERGENCY_CONTACTS:
        raise ValueError(f"Maximum {MAX_EMERGENCY_CONTACTS} emergency contacts allowed")

    # Edge case: duplicate email for same user
    if _emergency_contacts().find_one({"user_id": user_id, "email": email}):
        raise ValueError(f"Contact with email {email} already exists")

    # Generate verification code
    code = ''.join(random.choices(string.digits, k=6))

    contact = {
        "user_id": user_id,
        "name": name,
        "phone": phone,
        "email": email,
        "status": "pending",
        "verification_code": code,
        "code_expires": (datetime.now() + timedelta(minutes=CONTACT_CODE_EXPIRY_MINUTES)).isoformat(),
        "code_attempts": 0,
        "created_at": datetime.now().isoformat(),
        "verified_at": None
    }

    _emergency_contacts().insert_one(contact)
    logger.info(f"Emergency contact added (pending): {email} for user {user_id}")
    return {"name": name, "phone": phone, "email": email, "status": "pending", "_code": code}


def verify_emergency_contact(user_id: str, email: str, code: str) -> dict:
    """Verify emergency contact using the code they received."""
    contact = _emergency_contacts().find_one({"user_id": user_id, "email": email})
    if not contact:
        raise ValueError("Contact not found")

    if contact["status"] == "verified":
        raise ValueError("Contact is already verified")

    # Edge case: too many wrong attempts
    if contact["code_attempts"] >= MAX_CODE_ATTEMPTS:
        raise ValueError("Too many failed attempts. Please request a new code.")

    # Edge case: code expired
    if datetime.now().isoformat() > contact["code_expires"]:
        raise ValueError("Verification code has expired. Please request a new code.")

    # Edge case: wrong code
    if contact["verification_code"] != code:
        _emergency_contacts().update_one(
            {"user_id": user_id, "email": email},
            {"$inc": {"code_attempts": 1}}
        )
        remaining = MAX_CODE_ATTEMPTS - contact["code_attempts"] - 1
        raise ValueError(f"Invalid code. {remaining} attempts remaining.")

    # Verify the contact
    _emergency_contacts().update_one(
        {"user_id": user_id, "email": email},
        {"$set": {
            "status": "verified",
            "verified_at": datetime.now().isoformat(),
            "verification_code": None,
            "code_expires": None,
            "code_attempts": 0
        }}
    )

    logger.info(f"Emergency contact verified: {email} for user {user_id}")
    return {"name": contact["name"], "phone": contact["phone"], "email": email, "status": "verified"}


def resend_contact_code(user_id: str, email: str) -> str:
    """Resend verification code to a pending contact. Returns new code."""

    contact = _emergency_contacts().find_one({"user_id": user_id, "email": email})
    if not contact:
        raise ValueError("Contact not found")

    if contact["status"] == "verified":
        raise ValueError("Contact is already verified")

    # Generate new code and reset attempts
    code = ''.join(random.choices(string.digits, k=6))

    _emergency_contacts().update_one(
        {"user_id": user_id, "email": email},
        {"$set": {
            "verification_code": code,
            "code_expires": (datetime.now() + timedelta(minutes=CONTACT_CODE_EXPIRY_MINUTES)).isoformat(),
            "code_attempts": 0
        }}
    )

    logger.info(f"Resent verification code to {email} for user {user_id}")
    return code


def remove_emergency_contact(user_id: str, email: str) -> bool:
    """Remove an emergency contact (pending or verified)."""
    result = _emergency_contacts().delete_one({"user_id": user_id, "email": email})
    if result.deleted_count > 0:
        logger.info(f"Emergency contact removed: {email} for user {user_id}")
        return True
    return False


def get_emergency_contacts(user_id: str) -> list[dict]:
    """Get all emergency contacts for a user."""
    cursor = _emergency_contacts().find(
        {"user_id": user_id}
    )
    results = []
    for doc in cursor:
        results.append({
            "name": doc["name"],
            "phone": doc["phone"],
            "email": doc["email"],
            "status": doc["status"],
            "created_at": doc["created_at"],
            "verified_at": doc.get("verified_at")
        })
    return results


def get_verified_contacts(user_id: str) -> list[dict]:
    """Get only verified emergency contacts (for sending alerts)."""
    cursor = _emergency_contacts().find(
        {"user_id": user_id, "status": "verified"}
    )
    return [{"name": d["name"], "phone": d["phone"], "email": d["email"]} for d in cursor]


# ==================== Emergency Alert ====================

def trigger_emergency(user_id: str, gps_lat: float, gps_lon: float, message: str) -> dict:
    """
    Trigger emergency alert — sends location to ALL verified contacts.
    Returns the alert payload with list of notified contacts.
    """
    profile = _users().find_one({"user_id": user_id})
    if not profile:
        raise ValueError("User not found")

    contacts = get_verified_contacts(user_id)
    if not contacts:
        raise ValueError("No verified emergency contacts configured")

    alert = {
        "user_id": user_id,
        "user_name": profile["name"],
        "gps": {"lat": gps_lat, "lon": gps_lon},
        "google_maps_link": f"https://maps.google.com/?q={gps_lat},{gps_lon}",
        "message": message,
        "timestamp": datetime.now().isoformat(),
        "notified_contacts": contacts
    }

    # TODO: Send actual SMS/push to each contact (Twilio / other service)
    for contact in contacts:
        logger.warning(f"EMERGENCY ALERT to {contact['name']} ({contact['phone']}): {alert['google_maps_link']}")

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