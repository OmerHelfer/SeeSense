import os
from dotenv import load_dotenv

load_dotenv()


# ==================== Model ====================
# Which weights to serve. Env-overridable so the ONNX/PyTorch choice can be flipped
# on Railway (a variable change + restart) WITHOUT a code deploy — set
#     MODEL_PATH=ml_engine/seesense_model.onnx
# to try ONNX, and simply clear the variable to fall straight back to PyTorch.
#
# History (2026-07-31): a first ONNX attempt benchmarked 1.54x faster locally
# (99ms -> 64ms, identical detections) but was 75x SLOWER on Railway — YOLO
# 31ms -> 2323ms, and decode+quality 2.4ms -> 139ms too. OpenCV work slowing down
# as well proved it wasn't the model: the whole container was CPU-starved.
# Ultralytics builds its ONNX session as InferenceSession(weight, providers=...)
# with no SessionOptions, so ONNX Runtime sized its thread pool from the HOST's
# core count while the container only gets a fraction of a vCPU -> oversubscription
# and thrashing. A laptop never reproduces it: it really has the cores it counts.
# ONNX_NUM_THREADS below is the fix; see _configure_onnx_threads in model_loader.
MODEL_PATH = os.getenv("MODEL_PATH", "ml_engine/seesense_model.pt")

# Thread cap for ONNX Runtime. Containers are scheduled a fraction of a vCPU, so
# the default (one thread per host core) thrashes. Ignored when serving PyTorch.
#
# Measured on the same frame, both engines capped to the same budget (avg ms):
#     threads   PyTorch    ONNX     winner
#         1      108.9     204.2    PyTorch 1.88x
#         2      107.6     116.6    PyTorch 1.08x
#         4      105.5      78.9    ONNX    1.34x
#         8      112.4      61.6    ONNX    1.82x
#
# So ONNX only wins with >=4 usable threads. PyTorch is flat (~105-112ms) whatever
# it is given; ONNX scales hard — excellent on a big host, worse than PyTorch on a
# small one. That is the whole story of the Railway regression, and it is why the
# default stays on PyTorch: on the current plan ONNX has nothing to offer.
# Revisit if the server ever gets >=4 dedicated vCPUs (or a GPU, which is a
# different path entirely — see onnxruntime-gpu in requirements.txt).
ONNX_NUM_THREADS = int(os.getenv("ONNX_NUM_THREADS", "2"))
MODEL_MODE = "custom"  # "mock" | "pretrained" | "custom"

# ==================== Preprocessing ====================
# Fallback square input size (px), used ONLY if a client connects without sending
# an input_size. The real knob is the client's INPUT_SIZE (config/streamConfig.js),
# sent per-connection — you don't need to set the size here. Leave at the model's
# native 640.
TARGET_SIZE = 640

# Clamp range for the per-connection input size requested by the client.
# Smaller = faster inference + smaller uploads, but the model sees less detail.
MIN_INPUT_SIZE = 160
MAX_INPUT_SIZE = 640

# ==================== Real-time / Streaming ====================
# Target capture frame rate (FPS). The client captures + sends frames at this rate.
# NOTE: the effective rate is additionally capped by round-trip time (client-side
# backpressure won't send a new frame until the previous result returns), so if the
# server/network can't keep up the real FPS will be lower — that's visible on the
# admin performance page. Raise for faster reaction to fast objects (cars), lower to
# reduce load. Change this ONE number to tune the whole pipeline's frame rate; the
# client reads it automatically when the WebSocket connects.
# This is a CEILING — depth-1 backpressure self-throttles the real rate to ~1/RTT,
# so a high value here just lets the client run as fast as the pipe actually allows.
TARGET_FPS = 40

# ==================== Inference ====================
CONFIDENCE_THRESHOLD = 0.4
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
    "voice_gender": "default",  # "female" | "male" | "default" (system default voice)
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

