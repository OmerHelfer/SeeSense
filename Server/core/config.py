import os
from dotenv import load_dotenv

load_dotenv()


MODEL_PATH = "ml_engine/seesense_model.pt"
MODEL_MODE = "custom"

TARGET_SIZE = 640

MIN_INPUT_SIZE = 320
MAX_INPUT_SIZE = 640


CONFIDENCE_THRESHOLD = 0.4
NMS_IOU_THRESHOLD = 0.45

SENSITIVITY_PROFILES = {
    "low": {
        "confidence_threshold": 0.7,
        "bbox_close_ratio": 0.35,
        "bbox_medium_ratio": 0.25,
    },
    "medium": {
        "confidence_threshold": 0.55,
        "bbox_close_ratio": 0.22,
        "bbox_medium_ratio": 0.15,
    },
    "high": {
        "confidence_threshold": 0.4,
        "bbox_close_ratio": 0.1,
        "bbox_medium_ratio": 0.05,
    }
}

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

HIGH_RISK_CLASSES = {"car", "motorcycle", "bicycle", "person", "stairs", "dog", "bollard", "pothole", "scooter"}

DARK_IMAGE_THRESHOLD = 25
MIN_IMAGE_BYTES = 1000


DEFAULT_SETTINGS = {
    "alert_type": "both",
    "volume_intensity": 0.8,
    "vibration_intensity": 0.8,
    "voice_gender": "default",
    "detection_sensitivity": "medium",
    "high_risk_classes": list(HIGH_RISK_CLASSES)
}


VALID_PERIODS = {"all", "today", "week", "month", "three_months", "half_year", "older"}

VALID_FEEDBACK_TYPES = {"wrong_detection", "missed_obstacle", "general"}

CORS_ORIGINS = [
    "http://localhost:3000",
    "http://localhost:5173",
    "http://localhost:8080",
    "https://seesense.app",
    "https://seesense-production.up.railway.app",
]

_extra_origins = os.getenv("CORS_ORIGINS", "")
if _extra_origins:
    CORS_ORIGINS += [o.strip() for o in _extra_origins.split(",") if o.strip()]

JWT_SECRET_KEY = os.getenv("SECRET_KEY", "fallback-secret-for-dev-only")
JWT_ALGORITHM = "HS256"
JWT_EXPIRATION_HOURS = 24

MONGODB_URI = os.getenv("MONGODB_URI", "mongodb://localhost:27017")
MONGODB_DB_NAME = "seesense"

EMAIL_ADDRESS = os.getenv("EMAIL_ADDRESS", "")
EMAIL_PASSWORD = os.getenv("EMAIL_PASSWORD", "")

