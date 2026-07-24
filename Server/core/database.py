"""
MongoDB connection module.
Provides a single shared database client for the entire application.
"""
import logging
from pymongo import MongoClient

from core.config import MONGODB_URI, MONGODB_DB_NAME

logger = logging.getLogger(__name__)

_client = None
_db = None


def _ensure_indexes(db):
    """Create TTL indexes for collections that need automatic expiry."""
    from core.config import JWT_EXPIRATION_HOURS

    # Blacklisted tokens — expire after JWT lifetime (no need to keep after token expires anyway)
    db["blacklisted_tokens"].create_index(
        "created_at", expireAfterSeconds=JWT_EXPIRATION_HOURS * 3600
    )
    # Reset codes — expire after 15 minutes
    db["reset_codes"].create_index(
        "created_at", expireAfterSeconds=900
    )
    # Performance history — per-minute rollups. Index minute_ts for range queries,
    # and TTL created_at so history self-prunes after the retention window (~13
    # months, enough for a "last year" range).
    from services.perf_history import RETENTION_SECONDS
    db["perf_history"].create_index("minute_ts")
    db["perf_history"].create_index("created_at", expireAfterSeconds=RETENTION_SECONDS)
    logger.info("MongoDB TTL indexes ensured")


def connect():
    """Connect to MongoDB. Called once on server startup."""
    global _client, _db
    try:
        _client = MongoClient(MONGODB_URI)
        _db = _client[MONGODB_DB_NAME]
        # Test connection
        _client.admin.command("ping")
        _ensure_indexes(_db)
        logger.info(f"Connected to MongoDB: {MONGODB_DB_NAME}")
    except Exception as e:
        logger.error(f"Failed to connect to MongoDB: {e}")
        raise


def disconnect():
    """Close MongoDB connection. Called on server shutdown."""
    global _client
    if _client:
        _client.close()
        logger.info("MongoDB connection closed")


def get_db():
    """Get the database instance."""
    if _db is None:
        connect()
    return _db