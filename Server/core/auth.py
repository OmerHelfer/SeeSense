import jwt
import logging
from datetime import datetime, timedelta
from fastapi import HTTPException, Depends
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials

from core.config import JWT_SECRET_KEY, JWT_ALGORITHM, JWT_EXPIRATION_HOURS

logger = logging.getLogger(__name__)

security = HTTPBearer()


def create_token(user_id: str, email: str) -> str:
    """Create a JWT token for an authenticated user."""
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
    """
    FastAPI dependency — verifies JWT token from Authorization header.
    Usage: add to endpoint like: async def my_endpoint(user: dict = Depends(verify_token))
    """
    token = credentials.credentials
    try:
        payload = jwt.decode(token, JWT_SECRET_KEY, algorithms=[JWT_ALGORITHM])
        return {
            "user_id": payload["user_id"],
            "email": payload["email"]
        }
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token expired")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid token")