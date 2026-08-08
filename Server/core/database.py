import logging
from pymongo import MongoClient

from core.config import MONGODB_URI, MONGODB_DB_NAME

logger = logging.getLogger(__name__)

_client = None
_db = None


def _ensure_indexes(db):
    from core.config import JWT_EXPIRATION_HOURS

    db["blacklisted_tokens"].create_index(
        "created_at", expireAfterSeconds=JWT_EXPIRATION_HOURS * 3600
    )
    db["reset_codes"].create_index(
        "created_at", expireAfterSeconds=900
    )
    from services.perf_history import RETENTION_SECONDS
    db["perf_history"].create_index("minute_ts")
    db["perf_history"].create_index("created_at", expireAfterSeconds=RETENTION_SECONDS)
    db["perf_history"].create_index([("user_id", 1), ("minute_ts", 1)])
    logger.info("MongoDB TTL indexes ensured")


def connect():
    global _client, _db
    try:
        _client = MongoClient(MONGODB_URI)
        _db = _client[MONGODB_DB_NAME]
        _client.admin.command("ping")
        _ensure_indexes(_db)
        logger.info(f"Connected to MongoDB: {MONGODB_DB_NAME}")
    except Exception as e:
        logger.error(f"Failed to connect to MongoDB: {e}")
        raise


def disconnect():
    global _client
    if _client:
        _client.close()
        logger.info("MongoDB connection closed")


def get_db():
    if _db is None:
        connect()
    return _db