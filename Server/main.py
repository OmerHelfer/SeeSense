import sys
import os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager
import uvicorn
import logging

from api.inference import router as inference_router
from api.settings import router as settings_router
from api.stream import router as stream_router
from api.users import router as users_router
from ml_engine.model_loader import load_model
from core.config import MODEL_PATH, MODEL_MODE, CORS_ORIGINS
from utils.metrics import tracker

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("SeeSense server starting up...")
    app.state.model = load_model(MODEL_PATH, mode=MODEL_MODE)
    logger.info("Model loaded, server ready")
    yield
    logger.info("SeeSense server shutting down...")


app = FastAPI(title="SeeSense", lifespan=lifespan)

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


@app.get("/")
async def root():
    return {"message": "SeeSense server is running"}


@app.get("/get_system_status")
async def get_system_status():
    return tracker.get_status()


if __name__ == "__main__":
    uvicorn.run("main:app", host="127.0.0.1", port=8000, reload=True)