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


def connect():
    """Connect to MongoDB. Called once on server startup."""
    global _client, _db
    try:
        _client = MongoClient(MONGODB_URI)
        _db = _client[MONGODB_DB_NAME]
        # Test connection
        _client.admin.command("ping")
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