import os
from dotenv import load_dotenv

load_dotenv()


# ==================== Model ====================
MODEL_PATH = "ml_engine/weights/best.pt"
MODEL_MODE = "mock"  # "mock" | "pretrained" | "custom"

# ==================== Preprocessing ====================
TARGET_SIZE = 640

# ==================== Inference ====================
CONFIDENCE_THRESHOLD = 0.7
NMS_IOU_THRESHOLD = 0.45

# ==================== Danger Logic ====================
FRAME_AREA = TARGET_SIZE * TARGET_SIZE
BBOX_AREA_CLOSE_RATIO = 0.30
BBOX_AREA_MEDIUM_RATIO = 0.15

# Sensitivity profiles — affects confidence and bbox thresholds
SENSITIVITY_PROFILES = {
    "low": {
        "confidence_threshold": 0.85,
        "bbox_close_ratio": 0.40,
        "bbox_medium_ratio": 0.25,
    },
    "medium": {
        "confidence_threshold": 0.70,
        "bbox_close_ratio": 0.30,
        "bbox_medium_ratio": 0.15,
    },
    "high": {
        "confidence_threshold": 0.50,
        "bbox_close_ratio": 0.20,
        "bbox_medium_ratio": 0.10,
    }
}


# ==================== Class Mapping ====================
CLASS_NAMES = {
    0: "person",
    1: "car",
    2: "bus",
    3: "truck",
    4: "motorcycle",
    5: "bicycle",
    6: "stairs",
    7: "pole",
    8: "crosswalk",
    9: "pothole"
}

ALL_CLASSES = set(CLASS_NAMES.values())

# Default high risk classes (used when user hasn't customized)
HIGH_RISK_CLASSES = {"car", "bus", "truck", "motorcycle", "bicycle", "person", "stairs"}

# ==================== Edge Cases ====================
# Dark/black image detection — if mean pixel value is below this, reject the frame
DARK_IMAGE_THRESHOLD = 25  # pixel intensity 0-255

# Minimum image size in bytes (corrupt/empty file check)
MIN_IMAGE_BYTES = 1000

# ==================== CORS ====================
CORS_ORIGINS = [
    "http://localhost:3000",
    "http://localhost:5173",
    "http://localhost:8080",
    "https://seesense.app",
    "*"  # POC: allow all. Restrict in production.
]

# ==================== JWT Authentication ====================
JWT_SECRET_KEY = os.getenv("SECRET_KEY", "fallback-secret-for-dev-only")
JWT_ALGORITHM = "HS256"
JWT_EXPIRATION_HOURS = 24
