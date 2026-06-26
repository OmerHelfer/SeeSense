import os
from dotenv import load_dotenv

load_dotenv()


# ==================== Model ====================
MODEL_PATH = "ml_engine/weights/model_14_classes.pt"
MODEL_MODE = "custom"  # "mock" | "pretrained" | "custom"

# ==================== Preprocessing ====================
TARGET_SIZE = 640

# ==================== Inference ====================
CONFIDENCE_THRESHOLD = 0.3
NMS_IOU_THRESHOLD = 0.45

# ==================== Danger Logic ====================
FRAME_AREA = TARGET_SIZE * TARGET_SIZE
BBOX_AREA_CLOSE_RATIO = 0.30
BBOX_AREA_MEDIUM_RATIO = 0.15

# Sensitivity profiles — affects confidence and bbox thresholds
SENSITIVITY_PROFILES = {
    "low": {
        "confidence_threshold": 0.70,
        "bbox_close_ratio": 0.40,
        "bbox_medium_ratio": 0.25,
    },
    "medium": {
        "confidence_threshold": 0.50,
        "bbox_close_ratio": 0.15,
        "bbox_medium_ratio": 0.05,
    },
    "high": {
        "confidence_threshold": 0.35,
        "bbox_close_ratio": 0.08,
        "bbox_medium_ratio": 0.03,
    }
}

# ==================== Class Mapping ====================
CLASS_NAMES = {
    0: "person",
    1: "car",
    2: "bicycle",
    3: "motorcycle",
    4: "bench",
    5: "fire_hydrant",
    6: "traffic_light",
    7: "stairs",
    8: "pole",
    9: "dog",
    10: "bollard",
    11: "crosswalk",
    12: "pothole",
    13: "scooter"
}

ALL_CLASSES = set(CLASS_NAMES.values())

# Default high risk classes (used when user hasn't customized)
HIGH_RISK_CLASSES = {"car", "motorcycle", "bicycle", "person", "stairs", "dog", "bollard", "pothole", "scooter"}

# ==================== Edge Cases ====================
DARK_IMAGE_THRESHOLD = 25
MIN_IMAGE_BYTES = 1000

# Default Settings

DEFAULT_SETTINGS = {
    "alert_type": "both",
    "volume_intensity": 0.8,
    "vibration_intensity": 0.8,
    "detection_sensitivity": "medium",
    "high_risk_classes": list(HIGH_RISK_CLASSES)
}

# Valid Periods

VALID_PERIODS = {"all", "today", "week", "month", "three_months", "half_year", "older"}

# Valid Feedback Types
VALID_FEEDBACK_TYPES = {"wrong_detection", "missed_obstacle", "general"}

# ==================== CORS ====================
# Base allowed origins for local development.
CORS_ORIGINS = [
    "http://localhost:3000",
    "http://localhost:5173",
    "http://localhost:8080",
    "https://seesense.app",
    "https://seesense-production.up.railway.app",  # deployed client (Railway)
]

# Allow adding production origins via env var (comma-separated) without code changes.
_extra_origins = os.getenv("CORS_ORIGINS", "")
if _extra_origins:
    CORS_ORIGINS += [o.strip() for o in _extra_origins.split(",") if o.strip()]

# ==================== JWT Authentication ====================
JWT_SECRET_KEY = os.getenv("SECRET_KEY", "fallback-secret-for-dev-only")
JWT_ALGORITHM = "HS256"
JWT_EXPIRATION_HOURS = 24

# ==================== MongoDB ====================
MONGODB_URI = os.getenv("MONGODB_URI", "mongodb://localhost:27017")
MONGODB_DB_NAME = "seesense"

# ==================== Email ====================
EMAIL_ADDRESS = os.getenv("EMAIL_ADDRESS", "")
EMAIL_PASSWORD = os.getenv("EMAIL_PASSWORD", "")

