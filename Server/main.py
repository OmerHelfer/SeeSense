import os
os.environ.setdefault("YOLO_AUTOINSTALL", "false")


from fastapi import FastAPI, Depends, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from contextlib import asynccontextmanager
from pathlib import Path
import uvicorn
import logging.handlers
import time
from slowapi import Limiter
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded
from fastapi.responses import JSONResponse, FileResponse
from api.inference import router as inference_router
from api.settings import router as settings_router
from api.stream import router as stream_router
from api.users import router as users_router
from api.admin import router as admin_router
from ml_engine.model_loader import load_model
from core.config import MODEL_PATH, MODEL_MODE, CORS_ORIGINS
from core.database import connect, disconnect
from utils.metrics import tracker
from core.auth import verify_admin, verify_super_admin


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
    from services.perf_history import backfill_recording_start
    backfill_recording_start()
    # Before the model, so the very first WebSocket connect already sees the
    # stored values rather than falling back to defaults for one session.
    from services.stream_config_service import load_stream_config
    load_stream_config()
    app.state.model = load_model(MODEL_PATH, mode=MODEL_MODE)
    app.state.start_time = time.time()
    from services import db_writer
    db_writer.start()
    logger.info("Server is ready")
    yield
    db_writer.shutdown()
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


FRONTEND_DIST = Path(__file__).resolve().parent.parent / "Client" / "dist"
SERVE_FRONTEND = (FRONTEND_DIST / "index.html").is_file()


@app.get("/")
async def root():
    if SERVE_FRONTEND:
        return FileResponse(FRONTEND_DIST / "index.html")
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
        live = tracker.get_status()
        data["rtt_history"] = live.get("rtt_history", [])
        data["client_stage_latency"] = live.get("client_stage_latency", {})
        data["input_size"] = live.get("input_size")
        data["stream_config"] = live.get("stream_config")
        data["frame_bytes"] = live.get("frame_bytes", {})
        data["client_rtt"] = {
            **data.get("client_rtt", {}),
            "base_ms": live.get("client_rtt", {}).get("base_ms", 0.0),
        }
        live_fps = live.get("fps", {})
        data["fps"] = {
            **data.get("fps", {}),
            "server_capacity": live_fps.get("server_capacity", 0.0),
            "server_actual":   live_fps.get("server_actual", 0.0),
            "client_actual":   live_fps.get("client_actual", 0.0),
        }
        return data

    user = get_user_by_email(email.strip())
    if not user:
        raise HTTPException(status_code=404, detail="No user with that email")

    data = perf_history.query_range(None, None, user_id=user["user_id"])
    data["rtt_history"] = []
    data["client_stage_latency"] = {}
    data["user"] = {
        "user_id": user["user_id"],
        "email": user.get("email"),
        "name": user.get("name"),
        "created_at": user.get("created_at"),
    }
    return data


@app.post("/reset_system_status", summary="Super Admin Only — Reset Performance Data")
def reset_system_status(
    email: str | None = None,
    current_user: dict = Depends(verify_super_admin),
):
    """
    Super admin (level 2) only. Irreversible.

    No email → wipe everything: the live in-memory metrics and every user's
        persisted history.
    email=<user> → wipe only that user's persisted history.

    A scoped reset deliberately does NOT touch the live tracker: it is
    process-wide (capacity, RTT chart, client stages are not attributed per
    user), so clearing it would destroy every other user's live metrics as a
    side effect of resetting one person.
    """
    from services import perf_history
    from services.user_service import get_user_by_email

    if not email:
        tracker.reset()
        perf_history.reset_history()
        logger.warning(f"ALL performance data reset by {current_user.get('email')}")
        return {"status": "success", "scope": "all", "message": "All performance data reset"}

    user = get_user_by_email(email.strip())
    if not user:
        raise HTTPException(status_code=404, detail="No user with that email")

    perf_history.reset_history(user_id=user["user_id"])
    logger.warning(
        f"Performance data reset for {user.get('email')} by {current_user.get('email')}"
    )
    return {
        "status": "success",
        "scope": "user",
        "email": user.get("email"),
        "message": f"Performance data reset for {user.get('email')}",
    }

if SERVE_FRONTEND:
    assets_dir = FRONTEND_DIST / "assets"
    if assets_dir.is_dir():
        app.mount("/assets", StaticFiles(directory=assets_dir), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    async def spa_fallback(full_path: str):
        """
        Serve the SPA shell for any path the API didn't claim.

        React Router owns /login, /admin/status and the rest; those paths exist
        only in the browser, so a refresh or a shared link on one of them lands
        here and would otherwise 404. Real files (favicon, manifest) are still
        served directly when they exist.
        """
        candidate = (FRONTEND_DIST / full_path).resolve()
        if (
            full_path
            and candidate.is_file()
            and candidate.is_relative_to(FRONTEND_DIST)
        ):
            return FileResponse(candidate)
        return FileResponse(FRONTEND_DIST / "index.html")

    logger.info(f"Serving frontend build from {FRONTEND_DIST}")


if __name__ == "__main__":
    uvicorn.run("main:app", host="127.0.0.1", port=8000, reload=True)