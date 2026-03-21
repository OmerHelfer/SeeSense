from pydantic import BaseModel
from typing import Optional


class MotionData(BaseModel):
    track_id: int = -1          # Persistent object ID across frames (-1 = untracked)
    direction: str = "unknown"  # "left" | "right" | "center" | "unknown"
    approaching: bool = False
    speed: str = "unknown"      # "fast" | "moderate" | "static" | "moving_away" | "unknown"
    area_change: Optional[float] = None


class DetectedObject(BaseModel):
    class_name: str
    confidence: float
    bbox: list[float]
    area_ratio: float
    distance: str       # "Close" | "Medium" | "Far"
    position: str = "center"  # "left" | "center" | "right"
    alert_level: str    # "high" | "low" | "none"
    alert_message: str = ""   # Human-readable message for TTS
    motion: Optional[MotionData] = None


class AnalyzeFrameResponse(BaseModel):
    status: str
    filename: str
    danger: bool
    danger_cleared: bool = False  # True when danger just transitioned from True → False
    clearance_message: Optional[str] = None  # "Path Clear" / None
    alert_level: str    # "high" | "low" | "none"
    distance: str       # "Close" | "Medium" | "Far"
    objects: list[DetectedObject]