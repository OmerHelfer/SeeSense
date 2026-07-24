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
async def get_system_status(
    range: str = "live",
    start: int | None = None,
    end: int | None = None,
    current_user: dict = Depends(verify_admin),
):
    """
    Admin only — server performance metrics.

    range="live" (default) → real-time in-memory stats (since last reset/restart),
        including the RTT live chart and FPS breakdown.
    range in {start,30m,1h,1d,1w,1mo,3mo,6mo,1y} → aggregated from persisted
        per-minute history over that lookback window.
    range="custom" with start/end (epoch seconds) → aggregated over [start, end].
    """
    import time as _time
    from services import perf_history

    if range == "live":
        return tracker.get_status()

    if range == "custom":
        return perf_history.query_range(start, end)

    if range not in perf_history.RANGE_SECONDS:
        raise HTTPException(status_code=400, detail=f"Invalid range: {range}")

    lookback = perf_history.RANGE_SECONDS[range]
    start_ts = None if lookback is None else int(_time.time()) - lookback
    return perf_history.query_range(start_ts, None)


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