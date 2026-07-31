# Ultralytics tries to pip-install missing optional dependencies at runtime.
# A server must never install packages while serving requests — set this before
# any ultralytics import so that check becomes a no-op.
import os
os.environ.setdefault("YOLO_AUTOINSTALL", "false")

# Cap the maths thread pools BEFORE torch/numpy/OpenCV are imported — they read
# these variables at import time, so setting them later has no effect.
#
# Why: a container's cgroup caps how much CPU it may USE without changing the core
# count it SEES. Railway reported os.cpu_count()=48 while the replica limit is
# 8 vCPU, so torch spawned 48 threads for 8 vCPU worth of CPU — 6x oversubscribed,
# with the threads spending their time context-switching instead of working. A
# controlled sweep measured 16 threads on a 16-core machine running 4x SLOWER than
# 8 threads, and this is the same failure that made ONNX Runtime take 2323ms/frame.
#
# Set TORCH_NUM_THREADS=0 to disable the cap and restore the previous behaviour.
_threads = os.getenv("TORCH_NUM_THREADS", "8")
if _threads != "0":
    os.environ.setdefault("OMP_NUM_THREADS", _threads)
    os.environ.setdefault("MKL_NUM_THREADS", _threads)

from fastapi import FastAPI, Depends, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager
import uvicorn
import logging.handlers
import time
from slowapi import Limiter
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded
from fastapi.responses import JSONResponse
from api.inference import router as inference_router
from api.settings import router as settings_router
from api.stream import router as stream_router
from api.users import router as users_router
from api.admin import router as admin_router
from ml_engine.model_loader import load_model
from core.config import MODEL_PATH, MODEL_MODE, CORS_ORIGINS
from core.database import connect, disconnect
from utils.metrics import tracker
from core.auth import verify_token, verify_admin, verify_super_admin

import os

LOG_DIR = "logs"
os.makedirs(LOG_DIR, exist_ok=True)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(name)s | %(levelname)s | %(message)s",
    handlers=[
        logging.StreamHandler(),
        logging.handlers.RotatingFileHandler(
            f"{LOG_DIR}/seesense.log",
            maxBytes=5_000_000,
            backupCount=5,
            encoding="utf-8"
        )
    ]
)

logger = logging.getLogger(__name__)

@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("SeeSense server starting up...")
    connect()
    from services.user_service import migrate_admin_levels
    migrate_admin_levels()
    app.state.model = load_model(MODEL_PATH, mode=MODEL_MODE)
    app.state.start_time = time.time()
    logger.info("Server is ready")
    yield
    disconnect()
    logger.info("SeeSense server shutting down...")


app = FastAPI(title="SeeSense", lifespan=lifespan)

limiter = Limiter(key_func=get_remote_address)
app.state.limiter = limiter

@app.exception_handler(RateLimitExceeded)
async def rate_limit_handler(request, exc):
    return JSONResponse(
        status_code=429,
        content={"detail": "Too many requests. Please slow down."}
    )

# CORS — allows the client app to connect to the server
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(inference_router)
app.include_router(settings_router)
app.include_router(stream_router)
app.include_router(users_router)
app.include_router(admin_router)


@app.get("/")
async def root():
    return {"message": "SeeSense server is running"}


@app.get("/health")
async def health_check():
    """
    Lightweight health check for client to verify connectivity.
    Client pings this endpoint — if no response within timeout, switch to offline mode.
    """
    return {
        "status": "healthy",
        "model_mode": MODEL_MODE,
        "uptime_seconds": round(time.time() - app.state.start_time, 2)
    }


@app.get("/get_system_status", summary="Admin Only — System Performance")
def get_system_status(
    email: str | None = None,
    current_user: dict = Depends(verify_admin),
):
    """
    Admin only — server performance metrics, aggregated over all recorded history.

    No email → totals across every user, since recording began.
    email=<user email> → that user's own totals, since their first recorded frame.

    Always the full history rather than a selectable window: the persisted
    per-minute buckets already cover the whole retention period, so a lookback
    parameter only ever narrowed what was shown.

    Deliberately a sync `def` (FastAPI runs it in the threadpool): everything it
    does — flush_now's writes and the unbounded find() over every bucket — is
    BLOCKING pymongo. As `async def` that ran on the event loop, so one admin poll
    stalled the whole server, including the streaming WebSocket a user is walking
    with. Measured locally: find() over 50k buckets = ~1.1s, and the admin page
    polls this every 3s.
    """
    from services import perf_history
    from services.user_service import get_user_by_email

    if not email:
        data = perf_history.query_range(None, None)
        # Persisted buckets carry the all-time totals but not the two live-only
        # views: the RTT chart is a rolling in-memory series, and the client stage
        # breakdown is whatever the connected clients last reported. Merge them in
        # so one request still returns everything the page shows.
        live = tracker.get_status()
        data["rtt_history"] = live.get("rtt_history", [])
        data["client_stage_latency"] = live.get("client_stage_latency", {})
        return data

    user = get_user_by_email(email.strip())
    if not user:
        raise HTTPException(status_code=404, detail="No user with that email")

    data = perf_history.query_range(None, None, user_id=user["user_id"])
    # Deliberately NOT merged for a single user: the RTT chart and the client stage
    # timings are process-wide, so showing them beside one user's totals would
    # attribute other people's numbers to them.
    data["rtt_history"] = []
    data["client_stage_latency"] = {}
    # Echo identity so the page can label whose data it is showing.
    data["user"] = {
        "user_id": user["user_id"],
        "email": user.get("email"),
        "name": user.get("name"),
        "created_at": user.get("created_at"),
    }
    return data


@app.post("/reset_system_status", summary="Super Admin Only — Reset All Performance Data")
async def reset_system_status(current_user: dict = Depends(verify_super_admin)):
    """Super admin (level 2) only — wipe ALL performance data (live metrics +
    persisted history) and start counting fresh. Irreversible."""
    from services import perf_history
    tracker.reset()
    perf_history.reset_history()
    return {"status": "success", "message": "All performance data reset"}

if __name__ == "__main__":
    uvicorn.run("main:app", host="127.0.0.1", port=8000, reload=True)