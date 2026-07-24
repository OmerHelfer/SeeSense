import jwt
import logging
from datetime import datetime, timedelta
from fastapi import HTTPException, Depends
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials

from core.config import JWT_SECRET_KEY, JWT_ALGORITHM, JWT_EXPIRATION_HOURS

logger = logging.getLogger(__name__)

security = HTTPBearer()


def _blacklisted_col():
    from core.database import get_db
    return get_db()["blacklisted_tokens"]


def blacklist_token(token: str):
    """Add a token to the blacklist in MongoDB."""
    _blacklisted_col().insert_one({
        "token": token,
        "created_at": datetime.utcnow()
    })


def is_blacklisted(token: str) -> bool:
    """Check if a token has been blacklisted (logged out)."""
    return _blacklisted_col().find_one({"token": token}) is not None



def create_token(user_id: str, email: str) -> str:
    payload = {
        "user_id": user_id,
        "email": email,
        "exp": datetime.utcnow() + timedelta(hours=JWT_EXPIRATION_HOURS),
        "iat": datetime.utcnow()
    }
    token = jwt.encode(payload, JWT_SECRET_KEY, algorithm=JWT_ALGORITHM)
    logger.info(f"Token created for user: {user_id}")
    return token


def verify_token(credentials: HTTPAuthorizationCredentials = Depends(security)) -> dict:
    token = credentials.credentials

    if is_blacklisted(token):
        raise HTTPException(status_code=401, detail="Token has been revoked (logged out)")

    try:
        payload = jwt.decode(token, JWT_SECRET_KEY, algorithms=[JWT_ALGORITHM])
        # Stamp presence — any authenticated request marks the user as "online".
        from services.presence import mark_active
        mark_active(payload["user_id"])
        return {
            "user_id": payload["user_id"],
            "email": payload["email"],
            "token": token
        }
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token expired")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid token")

def get_admin_level(user_id: str) -> int:
    """
    Return a user's admin level: 0 = regular, 1 = admin, 2 = super admin.
    Falls back to is_admin for any user not yet migrated (is_admin True → 2).
    """
    from core.database import get_db
    profile = get_db()["users"].find_one({"user_id": user_id})
    if not profile:
        return 0
    if "admin_level" in profile:
        return int(profile["admin_level"])
    return 2 if profile.get("is_admin", False) else 0


def verify_admin(credentials: HTTPAuthorizationCredentials = Depends(security)) -> dict:
    """Verify token AND require admin (level >= 1). Adds admin_level to the user dict."""
    user = verify_token(credentials)
    level = get_admin_level(user["user_id"])
    if level < 1:
        raise HTTPException(status_code=403, detail="Admin access required")
    user["admin_level"] = level
    return user


def verify_super_admin(credentials: HTTPAuthorizationCredentials = Depends(security)) -> dict:
    """Verify token AND require super admin (level 2). Adds admin_level to the user dict."""
    user = verify_admin(credentials)
    if user["admin_level"] < 2:
        raise HTTPException(status_code=403, detail="Level 2 (super) admin access required")
    return user