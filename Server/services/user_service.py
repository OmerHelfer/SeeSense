import uuid
import bcrypt
import logging
import random
import string
from datetime import datetime, timedelta
from typing import Optional
from bson import ObjectId

from core.database import get_db

logger = logging.getLogger(__name__)


def _users():
    return get_db()["users"]

def _feedback():
    return get_db()["feedback"]

def _detection_history():
    return get_db()["detection_history"]


def _norm_email(email):
    """Canonical form of an email for storage + lookup.
    Emails are case-insensitive, so we lower-case (and trim) everywhere
    a user registers, logs in, or is searched for by an admin. This makes
    'OmErHelFER@GmAil.com' and 'omerhelfer@gmail.com' equivalent."""
    return email.strip().lower() if isinstance(email, str) else email


MAX_EMERGENCY_CONTACTS = 5
CONTACT_CODE_EXPIRY_MINUTES = 30
MAX_CODE_ATTEMPTS = 3



def migrate_admin_levels():
    """One-time backfill: give every user an admin_level field (0/1/2).
    Existing is_admin=True users become level 2 (super) so there's a bootstrap
    super admin; everyone else becomes level 0."""
    _users().update_many(
        {"is_admin": True, "admin_level": {"$exists": False}},
        {"$set": {"admin_level": 2}},
    )
    _users().update_many(
        {"admin_level": {"$exists": False}},
        {"$set": {"admin_level": 0, "is_admin": False}},
    )
    logger.info("Admin levels migration ensured")


def create_user(data: dict) -> dict:
    """Register a new user. Returns the created profile."""
    user_id = str(uuid.uuid4())[:8]

    email = _norm_email(data["email"])
    if _users().find_one({"email": email}):
        raise ValueError(f"Email {email} already registered")

    profile = {
        "user_id": user_id,
        "is_admin": False,
        "admin_level": 0,
        "name": data["name"],
        "email": email,
        "phone": data["phone"],
        "password_hash": _hash_password(data["password"]),
        "country": data.get("country"),
        "date_of_birth": data.get("date_of_birth"),
        "height_cm": data.get("height_cm"),
        "weight_kg": data.get("weight_kg"),
        "emergency_contacts": [],
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
    profile = _users().find_one({"email": _norm_email(email)})
    if not profile:
        return None

    if _verify_password(password, profile["password_hash"]):
        logger.info(f"User authenticated: {profile['user_id']}")
        return _safe_profile(profile)
    return None


def get_user_by_email(email: str) -> Optional[dict]:
    """Fetch user profile by email."""
    profile = _users().find_one({"email": _norm_email(email)})
    if not profile:
        return None
    return _safe_profile(profile)


def change_password(user_id: str, old_password: str, new_password: str, force: bool = False) -> bool:
    """
    Change user password.
    If force=True, skip old password check (for password reset).
    """
    profile = _users().find_one({"user_id": user_id})
    if not profile:
        return False

    if not force:
        if not _verify_password(old_password, profile["password_hash"]):
            return False

    new_hash = _hash_password(new_password)
    _users().update_one({"user_id": user_id}, {"$set": {"password_hash": new_hash}})
    logger.info(f"Password changed for user: {user_id}")
    return True



def build_detection_entry(user_id: str, record: dict, session_id: str = None):
    """Build a detection-history document with a pre-generated _id (no DB write).

    Returns (record_id_str, entry_dict). The caller can return record_id to the
    client immediately and persist `entry` asynchronously via insert_detection_entry,
    keeping the DB write off the hot path.
    """
    raw_objects = record.get("objects", [])
    objects_summary = []
    for obj in raw_objects:
        objects_summary.append({
            "class_name": obj.get("class_name", "unknown"),
            "confidence": round(obj.get("confidence", 0), 2),
            "distance": obj.get("distance", "Far"),
        })

    entry = {
        "_id": ObjectId(),
        "user_id": user_id,
        "session_id": session_id,
        "timestamp": datetime.now().isoformat(),
        "danger": record.get("danger", False),
        "alert_level": record.get("alert_level", "none"),
        "distance": record.get("distance", "Far"),
        "objects_detected": len(raw_objects),
        "objects": objects_summary
    }
    return str(entry["_id"]), entry


def insert_detection_entry(entry: dict) -> None:
    """Persist a pre-built detection-history document (safe to call in a thread)."""
    try:
        _detection_history().insert_one(entry)
    except Exception as e:
        logger.warning(f"Deferred detection insert failed: {e}")
def get_user_history(user_id: str, limit: int = 50, period: str = "all", session_id: str = None) -> list[dict]:
    """Retrieve detection history filtered by time period and/or session."""
    query = {"user_id": user_id}

    if session_id:
        query["session_id"] = session_id

    if period != "all":
        now = datetime.now()
        periods = {
            "today": timedelta(days=1),
            "week": timedelta(weeks=1),
            "month": timedelta(days=30),
            "three_months": timedelta(days=90),
            "half_year": timedelta(days=180),
            "older": None
        }
        delta = periods.get(period)
        if period == "older":
            cutoff = (now - timedelta(days=180)).isoformat()
            query["timestamp"] = {"$lt": cutoff}
        elif delta:
            cutoff = (now - delta).isoformat()
            query["timestamp"] = {"$gte": cutoff}

    cursor = _detection_history().find(query).sort("timestamp", -1).limit(limit)

    results = []
    for doc in cursor:
        doc["record_id"] = str(doc["_id"])
        del doc["_id"]
        del doc["user_id"]
        results.append(doc)
    return results


def delete_detection_record(user_id: str, record_id: str) -> bool:
    """Delete a single detection record by ID."""
    result = _detection_history().delete_one({"_id": ObjectId(record_id), "user_id": user_id})
    return result.deleted_count > 0


def clear_user_history(user_id: str) -> int:
    """Delete all detection history for a user. Returns count deleted."""
    result = _detection_history().delete_many({"user_id": user_id})
    logger.info(f"Cleared {result.deleted_count} history records for user: {user_id}")
    return result.deleted_count



def create_quick_feedback(user_id: str, feedback_type: str, record_id: str = None) -> str:
    """Quick feedback from user during walk — no notes, status is pending."""
    detection_snapshot = None

    if record_id:
        try:
            record = _detection_history().find_one({"_id": ObjectId(record_id), "user_id": user_id})
        except Exception:
            raise ValueError("Invalid record ID format")

        if not record:
            raise ValueError("Detection record not found")

        existing = _feedback().find_one({"user_id": user_id, "record_id": record_id})
        if existing:
            raise ValueError("Feedback already exists for this record")

        detection_snapshot = {
            "timestamp": record.get("timestamp"),
            "danger": record.get("danger", False),
            "alert_level": record.get("alert_level", "none"),
            "distance": record.get("distance", "Far"),
            "objects": record.get("objects", []),
            "objects_detected": record.get("objects_detected", 0),
        }

    from core.database import get_db
    session = get_db()["sessions"].find_one({"user_id": user_id, "status": "active"})
    session_id = session["session_id"] if session else None

    entry = {
        "user_id": user_id,
        "feedback_type": feedback_type,
        "record_id": record_id,
        "session_id": session_id,
        "detection_snapshot": detection_snapshot,
        "notes": None,
        "status": "pending",
        "created_at": datetime.now().isoformat(),
        "updated_at": None
    }
    result = _feedback().insert_one(entry)
    logger.info(f"Quick feedback from {user_id}: {feedback_type}")
    return str(result.inserted_id)


def create_feedback_from_history(user_id: str, record_id: str, feedback_type: str, notes: str = None) -> str:
    """Companion creates feedback from a specific history record."""
    try:
        record = _detection_history().find_one({"_id": ObjectId(record_id), "user_id": user_id})
    except Exception:
        raise ValueError("Invalid record ID format")

    if not record:
        raise ValueError("Detection record not found")

    existing = _feedback().find_one({"user_id": user_id, "record_id": record_id})
    if existing:
        raise ValueError("Feedback already exists for this record")

    detection_snapshot = {
        "timestamp": record.get("timestamp"),
        "danger": record.get("danger", False),
        "alert_level": record.get("alert_level", "none"),
        "distance": record.get("distance", "Far"),
        "objects": record.get("objects", []),
        "objects_detected": record.get("objects_detected", 0),
    }

    entry = {
        "user_id": user_id,
        "feedback_type": feedback_type,
        "record_id": record_id,
        "detection_snapshot": detection_snapshot,
        "notes": notes,
        "status": "submitted",
        "created_at": datetime.now().isoformat(),
        "updated_at": None
    }
    result = _feedback().insert_one(entry)
    logger.info(f"Feedback from history for {user_id}: {feedback_type} on record {record_id}")
    return str(result.inserted_id)


def create_standalone_feedback(user_id: str, feedback_type: str, notes: str = None) -> str:
    """Standalone feedback — not linked to any specific detection."""
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
    """Get all pending feedback for a user."""
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
    """Get all feedback for a user (incl. the admin-handling status + response so the
    user can see how their feedback was handled)."""
    cursor = _feedback().find(
        {"user_id": user_id}
    ).sort("created_at", -1)

    results = []
    for doc in cursor:
        doc["feedback_id"] = str(doc["_id"])
        doc["handling_status"] = _norm_handling(doc)
        del doc["_id"]
        del doc["user_id"]
        results.append(doc)
    return results


def update_feedback(user_id: str, feedback_id: str, notes: str = None, feedback_type: str = None) -> dict:
    """Companion updates a feedback — adds notes and/or changes type. Marks as submitted.
    Locked once an admin starts handling it: editing is only allowed while the feedback
    is still 'pending' (nobody has taken/resolved it)."""
    existing = _feedback().find_one({"_id": ObjectId(feedback_id), "user_id": user_id})
    if not existing:
        return None
    if _norm_handling(existing) != "pending":
        raise ValueError("המשוב כבר בטיפול ולא ניתן לערוך אותו")

    updates = {"updated_at": datetime.now().isoformat(), "status": "submitted"}
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
    result = _feedback().update_one(
        {"_id": ObjectId(feedback_id), "user_id": user_id, "status": "pending"},
        {"$set": {"status": "submitted", "updated_at": datetime.now().isoformat()}}
    )
    return result.modified_count > 0


def delete_feedback(user_id: str, feedback_id: str) -> bool:
    """Delete a feedback entry."""
    result = _feedback().delete_one({"_id": ObjectId(feedback_id), "user_id": user_id})
    return result.deleted_count > 0


def count_unseen_responses(user_id: str) -> int:
    """Number of resolved feedbacks whose admin response the user hasn't seen yet.
    Drives the 'new response' badge. Legacy docs (no response_seen field) don't count."""
    return _feedback().count_documents({
        "user_id": user_id,
        "handling_status": "resolved",
        "response_seen": False,
    })


def mark_responses_seen(user_id: str) -> int:
    """Mark all of the user's resolved-feedback responses as seen (clears the badge).
    Returns how many were updated."""
    result = _feedback().update_many(
        {"user_id": user_id, "handling_status": "resolved", "response_seen": False},
        {"$set": {"response_seen": True}},
    )
    return result.modified_count



VALID_HANDLING = {"pending", "in_progress", "resolved"}


def _norm_handling(doc: dict) -> str:
    hs = doc.get("handling_status")
    return hs if hs in VALID_HANDLING else "pending"


def _try_oid(feedback_id: str) -> ObjectId:
    try:
        return ObjectId(feedback_id)
    except Exception:
        raise ValueError("Invalid feedback id")


def _feedback_admin_view(doc: dict, user_map: dict = None) -> dict:
    """Shape one feedback doc for the admin management view: the submitting user's
    name/email + normalized handling fields. `user_map` (user_id → user doc) lets the
    list path avoid an extra query per row; omit it for a single doc."""
    uid = doc.get("user_id")
    if user_map is not None:
        u = user_map.get(uid, {})
    else:
        u = _users().find_one({"user_id": uid}, {"name": 1, "email": 1}) or {}
    return {
        "feedback_id": str(doc["_id"]),
        "user_id": uid,
        "user_name": u.get("name"),
        "user_email": u.get("email"),
        "feedback_type": doc.get("feedback_type"),
        "notes": doc.get("notes"),
        "record_id": doc.get("record_id"),
        "detection_snapshot": doc.get("detection_snapshot"),
        "created_at": doc.get("created_at"),
        "updated_at": doc.get("updated_at"),
        "handling_status": _norm_handling(doc),
        "assigned_admin_id": doc.get("assigned_admin_id"),
        "handling_admin_id": doc.get("handling_admin_id"),
        "handling_admin_name": doc.get("handling_admin_name"),
        "admin_response": doc.get("admin_response"),
        "handling_started_at": doc.get("handling_started_at"),
        "resolved_at": doc.get("resolved_at"),
    }


def get_all_feedback_admin(handling_status: str = None) -> list:
    """All *submitted* feedbacks from ALL users (admin management view), newest first.
    Optional filter by handling_status (pending/in_progress/resolved)."""
    docs = list(_feedback().find({"status": "submitted"}).sort("created_at", -1))
    uids = list({d.get("user_id") for d in docs if d.get("user_id")})
    user_map = {
        u["user_id"]: u
        for u in _users().find({"user_id": {"$in": uids}}, {"user_id": 1, "name": 1, "email": 1})
    }
    views = [_feedback_admin_view(d, user_map) for d in docs]
    if handling_status in VALID_HANDLING:
        views = [v for v in views if v["handling_status"] == handling_status]
    return views


def get_feedback_admin_stats() -> dict:
    """Counts of submitted feedbacks by handling status (+ total)."""
    counts = {"pending": 0, "in_progress": 0, "resolved": 0}
    for d in _feedback().find({"status": "submitted"}, {"handling_status": 1}):
        counts[_norm_handling(d)] += 1
    counts["total"] = counts["pending"] + counts["in_progress"] + counts["resolved"]
    return counts


def _admin_name(admin_id: str) -> str:
    u = _users().find_one({"user_id": admin_id}, {"name": 1})
    return (u or {}).get("name")


def admin_take_feedback(feedback_id: str, admin_id: str) -> dict:
    """An admin takes a pending feedback for themselves → in_progress. Only allowed
    while it's still pending (nobody else is handling it)."""
    oid = _try_oid(feedback_id)
    doc = _feedback().find_one({"_id": oid})
    if not doc:
        return None
    if _norm_handling(doc) != "pending":
        raise ValueError("Feedback is already being handled")
    updates = {
        "handling_status": "in_progress",
        "handling_admin_id": admin_id,
        "handling_admin_name": _admin_name(admin_id),
        "handling_started_at": datetime.now().isoformat(),
    }
    r = _feedback().find_one_and_update({"_id": oid}, {"$set": updates}, return_document=True)
    return _feedback_admin_view(r)


def admin_resolve_feedback(feedback_id: str, admin_id: str, admin_level: int, response: str) -> dict:
    """Mark a feedback resolved with a required response note describing what the admin
    did. Only the handling admin, or a super admin (level 2), may resolve. If resolved
    straight from pending, the resolver is recorded as the handling admin."""
    if not response or not response.strip():
        raise ValueError("A resolution note is required")
    oid = _try_oid(feedback_id)
    doc = _feedback().find_one({"_id": oid})
    if not doc:
        return None
    if _norm_handling(doc) == "resolved":
        raise ValueError("Feedback already resolved")
    handler = doc.get("handling_admin_id")
    if admin_level < 2 and handler and handler != admin_id:
        raise ValueError("Only the handling admin or a super admin can resolve this")
    now = datetime.now().isoformat()
    updates = {
        "handling_status": "resolved",
        "admin_response": response.strip(),
        "resolved_at": now,
        "response_seen": False,
    }
    if not handler:
        updates["handling_admin_id"] = admin_id
        updates["handling_admin_name"] = _admin_name(admin_id)
        updates["handling_started_at"] = doc.get("handling_started_at") or now
    r = _feedback().find_one_and_update({"_id": oid}, {"$set": updates}, return_document=True)
    return _feedback_admin_view(r)


def admin_assign_feedback(feedback_id: str, assignee_id: str) -> dict:
    """Super admin assigns a feedback to a specific admin → in_progress under them,
    without that admin having to pick it. Cannot reassign an already-resolved one."""
    oid = _try_oid(feedback_id)
    assignee = _users().find_one({"user_id": assignee_id})
    if not assignee or _admin_level_of(assignee) < 1:
        raise ValueError("Assignee must be an admin")
    doc = _feedback().find_one({"_id": oid})
    if not doc:
        return None
    if _norm_handling(doc) == "resolved":
        raise ValueError("Cannot reassign a resolved feedback")
    updates = {
        "handling_status": "in_progress",
        "assigned_admin_id": assignee_id,
        "handling_admin_id": assignee_id,
        "handling_admin_name": assignee.get("name"),
        "handling_started_at": datetime.now().isoformat(),
    }
    r = _feedback().find_one_and_update({"_id": oid}, {"$set": updates}, return_document=True)
    return _feedback_admin_view(r)



def add_emergency_contact(user_id: str, name: str, phone: str, email: str) -> dict:
    """
    Add a new emergency contact to user's embedded array.
    Sends verification code to their email. Contact stays pending until verified.
    """
    expired = _cleanup_expired_contacts(user_id)
    if expired:
        from services.email_service import send_contact_expired_notification
        import threading
        profile = _users().find_one({"user_id": user_id})

        def _notify_expired(to_email, to_name, items):
            for _exp_email, exp_name in items:
                try:
                    send_contact_expired_notification(to_email, to_name, exp_name)
                except Exception as e:
                    logger.error(f"Failed to send contact-expired notification: {e}")

        threading.Thread(
            target=_notify_expired,
            args=(profile["email"], profile["name"], expired),
            daemon=True,
        ).start()

    profile = _users().find_one({"user_id": user_id})
    if not profile:
        raise ValueError("User not found")

    if email == profile["email"]:
        raise ValueError("Cannot add yourself as an emergency contact")

    contacts = profile.get("emergency_contacts", [])

    if len(contacts) >= MAX_EMERGENCY_CONTACTS:
        raise ValueError(f"Maximum {MAX_EMERGENCY_CONTACTS} emergency contacts allowed")

    for c in contacts:
        if c["email"] == email:
            raise ValueError(f"Contact with email {email} already exists")

    code = ''.join(random.choices(string.digits, k=6))

    contact = {
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

    _users().update_one(
        {"user_id": user_id},
        {"$push": {"emergency_contacts": contact}}
    )

    logger.info(f"Emergency contact added (pending): {email} for user {user_id}")
    return {"name": name, "phone": phone, "email": email, "status": "pending", "_code": code}


def verify_emergency_contact(user_id: str, email: str, code: str) -> dict:
    """Verify emergency contact using the code they received."""
    _cleanup_expired_contacts(user_id)
    profile = _users().find_one({"user_id": user_id})
    if not profile:
        raise ValueError("User not found")

    contacts = profile.get("emergency_contacts", [])
    contact = next((c for c in contacts if c["email"] == email), None)

    if not contact:
        raise ValueError("Contact not found")

    if contact["status"] == "verified":
        raise ValueError("Contact is already verified")

    if contact["code_attempts"] >= MAX_CODE_ATTEMPTS:
        raise ValueError("Too many failed attempts. Please request a new code.")

    if datetime.now().isoformat() > contact["code_expires"]:
        raise ValueError("Verification code has expired. Please request a new code.")

    if contact["verification_code"] != code:
        _users().update_one(
            {"user_id": user_id, "emergency_contacts.email": email},
            {"$inc": {"emergency_contacts.$.code_attempts": 1}}
        )
        remaining = MAX_CODE_ATTEMPTS - contact["code_attempts"] - 1
        raise ValueError(f"Invalid code. {remaining} attempts remaining.")

    _users().update_one(
        {"user_id": user_id, "emergency_contacts.email": email},
        {"$set": {
            "emergency_contacts.$.status": "verified",
            "emergency_contacts.$.verified_at": datetime.now().isoformat(),
            "emergency_contacts.$.verification_code": None,
            "emergency_contacts.$.code_expires": None,
            "emergency_contacts.$.code_attempts": 0
        }}
    )

    logger.info(f"Emergency contact verified: {email} for user {user_id}")
    return {"name": contact["name"], "phone": contact["phone"], "email": email, "status": "verified"}


def resend_contact_code(user_id: str, email: str) -> str:
    """Resend verification code to a pending contact. Returns new code."""
    _cleanup_expired_contacts(user_id)
    profile = _users().find_one({"user_id": user_id})
    if not profile:
        raise ValueError("User not found")

    contacts = profile.get("emergency_contacts", [])
    contact = next((c for c in contacts if c["email"] == email), None)

    if not contact:
        raise ValueError("Contact not found")

    if contact["status"] == "verified":
        raise ValueError("Contact is already verified")

    code = ''.join(random.choices(string.digits, k=6))

    _users().update_one(
        {"user_id": user_id, "emergency_contacts.email": email},
        {"$set": {
            "emergency_contacts.$.verification_code": code,
            "emergency_contacts.$.code_expires": (datetime.now() + timedelta(minutes=CONTACT_CODE_EXPIRY_MINUTES)).isoformat(),
            "emergency_contacts.$.code_attempts": 0
        }}
    )

    logger.info(f"Resent verification code to {email} for user {user_id}")
    return code


def remove_emergency_contact(user_id: str, email: str) -> bool:
    """Remove an emergency contact from user's array."""
    result = _users().update_one(
        {"user_id": user_id},
        {"$pull": {"emergency_contacts": {"email": email}}}
    )
    if result.modified_count > 0:
        logger.info(f"Emergency contact removed: {email} for user {user_id}")
        return True
    return False


def get_emergency_contacts(user_id: str) -> list[dict]:
    """Get all emergency contacts for a user (without internal fields)."""
    _cleanup_expired_contacts(user_id)
    profile = _users().find_one({"user_id": user_id})
    if not profile:
        return []

    contacts = profile.get("emergency_contacts", [])
    return [{
        "name": c["name"],
        "phone": c["phone"],
        "email": c["email"],
        "status": c["status"],
        "created_at": c["created_at"],
        "verified_at": c.get("verified_at")
    } for c in contacts]


def get_verified_contacts(user_id: str) -> list[dict]:
    """Get only verified emergency contacts (for sending alerts)."""
    _cleanup_expired_contacts(user_id)
    profile = _users().find_one({"user_id": user_id})
    if not profile:
        return []

    contacts = profile.get("emergency_contacts", [])
    return [{"name": c["name"], "phone": c["phone"], "email": c["email"]}
            for c in contacts if c["status"] == "verified"]




def _hash_password(password: str) -> bytes:
    """Hash password using bcrypt."""
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt())


def _verify_password(password: str, hashed: bytes) -> bool:
    """Verify password against bcrypt hash."""
    return bcrypt.checkpw(password.encode("utf-8"), hashed)


def _safe_profile(profile: dict) -> dict:
    """Return profile without password hash, MongoDB _id, and internal contact fields."""
    safe = {k: v for k, v in profile.items() if k not in ("password_hash", "_id")}

    if "emergency_contacts" in safe:
        safe["emergency_contacts"] = [{
            "name": c["name"],
            "phone": c["phone"],
            "email": c["email"],
            "status": c["status"],
            "created_at": c["created_at"],
            "verified_at": c.get("verified_at")
        } for c in safe["emergency_contacts"]]

    return safe

def _cleanup_expired_contacts(user_id: str) -> list[str]:
    """Remove pending contacts whose verification code has expired. Returns removed names."""
    profile = _users().find_one({"user_id": user_id})
    if not profile:
        return []

    contacts = profile.get("emergency_contacts", [])
    now = datetime.now().isoformat()

    expired = [(c["email"], c["name"]) for c in contacts
               if c["status"] == "pending" and c.get("code_expires") and c["code_expires"] < now]

    for email, name in expired:
        _users().update_one(
            {"user_id": user_id},
            {"$pull": {"emergency_contacts": {"email": email}}}
        )
        logger.info(f"Expired contact removed: {email} for user {user_id}")

    return expired


def _emergency_alerts():
    return get_db()["emergency_alerts"]


def trigger_emergency(user_id: str, gps_lat: float | None, gps_lon: float | None) -> dict:
    from services.email_service import send_emergency_alert_email

    profile = _users().find_one({"user_id": user_id})
    if not profile:
        raise ValueError("User not found")

    contacts = get_verified_contacts(user_id)
    if not contacts:
        raise ValueError("No verified emergency contacts configured")

    has_fix = gps_lat is not None and gps_lon is not None
    maps_link = f"https://maps.google.com/?q={gps_lat},{gps_lon}" if has_fix else None

    alert = {
        "alert_id": str(uuid.uuid4()),
        "user_id": user_id,
        "user_name": profile["name"],
        "gps": {"lat": gps_lat, "lon": gps_lon},
        "google_maps_link": maps_link,
        "timestamp": datetime.now().isoformat(),
        "notified_contacts": [
            {"name": c["name"], "email": c["email"], "phone": c.get("phone", "")}
            for c in contacts
        ],
    }

    _emergency_alerts().insert_one(alert.copy())

    import threading

    def _notify_contacts():
        for contact in contacts:
            try:
                send_emergency_alert_email(
                    contact["email"],
                    contact["name"],
                    profile["name"],
                    maps_link,
                )
                logger.warning(f"EMERGENCY ALERT to {contact['name']} ({contact['email']}): {maps_link}")
            except Exception as e:
                logger.error(f"Failed to send emergency alert to {contact.get('email')}: {e}")

    threading.Thread(target=_notify_contacts, daemon=True).start()

    return alert


def get_emergency_alert_history(user_id: str, limit: int = 50) -> list:
    """Return emergency alerts for a user, newest first."""
    alerts = list(
        _emergency_alerts()
        .find({"user_id": user_id}, {"_id": 0})
        .sort("timestamp", -1)
        .limit(limit)
    )
    return alerts


def touch_last_seen(user_id: str):
    """Update last_seen (called on login and WS disconnect)."""
    _users().update_one({"user_id": user_id}, {"$set": {"last_seen": datetime.now().isoformat()}})


def is_last_super_admin(user_id: str) -> bool:
    """True if this user is a super admin (level 2) and the only one left."""
    profile = _users().find_one({"user_id": user_id})
    if not profile or _admin_level_of(profile) != 2:
        return False
    return _users().count_documents({"admin_level": 2}) <= 1


def get_users_overview() -> dict:
    """Aggregate counts for the admin dashboard: total / online / offline / admins /
    admins_online."""
    from services.presence import get_online_user_ids
    online_ids = get_online_user_ids()
    total = _users().count_documents({})
    online = len(online_ids)
    admin_ids = {p["user_id"] for p in _users().find({"admin_level": {"$gte": 1}}, {"user_id": 1})}
    return {
        "total": total,
        "online": online,
        "offline": max(0, total - online),
        "admins": len(admin_ids),
        "admins_online": len(admin_ids & online_ids),
    }


def list_admins() -> list:
    """All admin accounts (level 1+) with presence + last_seen, for the admin-status
    modal. Returned unsorted — the client sorts (online first by level, then offline
    by last_seen). Any admin (level 1+) may view this."""
    from services.presence import is_online
    admins = []
    for p in _users().find({"admin_level": {"$gte": 1}}):
        uid = p["user_id"]
        admins.append({
            "user_id": uid,
            "name": p.get("name"),
            "email": p.get("email"),
            "admin_level": _admin_level_of(p),
            "online": is_online(uid),
            "last_seen": p.get("last_seen"),
        })
    return admins


def _admin_level_of(profile: dict) -> int:
    if "admin_level" in profile:
        return int(profile["admin_level"])
    return 2 if profile.get("is_admin", False) else 0


def get_user_admin_view(email: str) -> Optional[dict]:
    """Full admin-facing view of a user: profile + admin level + online status +
    last_seen + counts of their data."""
    profile = _users().find_one({"email": _norm_email(email)})
    if not profile:
        return None
    from services.presence import is_online
    uid = profile["user_id"]
    level = _admin_level_of(profile)
    return {
        "user_id": uid,
        "name": profile.get("name"),
        "email": profile.get("email"),
        "phone": profile.get("phone"),
        "country": profile.get("country"),
        "date_of_birth": profile.get("date_of_birth"),
        "height_cm": profile.get("height_cm"),
        "weight_kg": profile.get("weight_kg"),
        "created_at": profile.get("created_at"),
        "admin_level": level,
        "is_admin": level >= 1,
        "online": is_online(uid),
        "last_seen": profile.get("last_seen"),
        "emergency_contacts": get_emergency_contacts(uid),
        "data_counts": {
            "detections": _detection_history().count_documents({"user_id": uid}),
            "feedback": _feedback().count_documents({"user_id": uid}),
            "sessions": get_db()["sessions"].count_documents({"user_id": uid}),
            "emergency_contacts": len(profile.get("emergency_contacts", [])),
            "sos_alerts": _emergency_alerts().count_documents({"user_id": uid}),
        },
    }


def admin_set_password(email: str, new_password: str) -> bool:
    """Admin sets a user's password directly (by email)."""
    email = _norm_email(email)
    profile = _users().find_one({"email": email})
    if not profile:
        raise ValueError("User not found")
    _users().update_one({"email": email}, {"$set": {"password_hash": _hash_password(new_password)}})
    logger.info(f"Admin reset password for {email}")
    return True


def admin_update_user(email: str, updates: dict) -> Optional[dict]:
    """Admin edits a user's profile fields (by email)."""
    profile = _users().find_one({"email": _norm_email(email)})
    if not profile:
        raise ValueError("User not found")
    return update_user(profile["user_id"], updates)


def admin_set_admin_level(email: str, level: int) -> int:
    """Grant/revoke admin. level: 0 regular, 1 admin, 2 super admin.
    Guards against demoting the last remaining super admin (lockout)."""
    if level not in (0, 1, 2):
        raise ValueError("Invalid admin level (must be 0, 1 or 2)")
    email = _norm_email(email)
    profile = _users().find_one({"email": email})
    if not profile:
        raise ValueError("User not found")
    current = _admin_level_of(profile)
    if current == 2 and level < 2 and _users().count_documents({"admin_level": 2}) <= 1:
        raise ValueError("Cannot demote the last super admin")
    _users().update_one({"email": email}, {"$set": {"admin_level": level, "is_admin": level >= 1}})
    logger.info(f"Admin set {email} to admin_level={level}")
    return level


def admin_delete_user_by_email(email: str) -> bool:
    """Admin deletes a user by email. Guards against deleting the last super admin."""
    profile = _users().find_one({"email": _norm_email(email)})
    if not profile:
        raise ValueError("User not found")
    if _admin_level_of(profile) == 2 and _users().count_documents({"admin_level": 2}) <= 1:
        raise ValueError("Cannot delete the last super admin")
    return delete_user_account(profile["user_id"])


def delete_user_account(user_id: str) -> bool:
    """
    Delete user account and ALL associated data.
    Removes: profile, detection history, feedback, sessions.
    """
    profile = _users().find_one({"user_id": user_id})
    if not profile:
        return False

    _users().delete_one({"user_id": user_id})
    _detection_history().delete_many({"user_id": user_id})
    _feedback().delete_many({"user_id": user_id})
    _emergency_alerts().delete_many({"user_id": user_id})
    get_db()["sessions"].delete_many({"user_id": user_id})
    get_db()["settings"].delete_many({"user_id": user_id})

    logger.info(f"Account deleted: {user_id} ({profile['name']})")
    return True