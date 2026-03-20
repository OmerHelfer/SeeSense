from pydantic import BaseModel
from typing import Optional


class MotionData(BaseModel):
    direction: str = "unknown"      # "left" | "right" | "center" | "unknown"
    approaching: bool = False
    speed: str = "unknown"          # "fast" | "moderate" | "static" | "moving_away" | "unknown"
    area_change: Optional[float] = None


class DetectedObject(BaseModel):
    class_name: str
    confidence: float
    bbox: list[float]
    area_ratio: float
    distance: str       # "Close" | "Medium" | "Far"
    alert_level: str    # "high" | "low" | "none"
    motion: Optional[MotionData] = None


class AnalyzeFrameResponse(BaseModel):
    status: str
    filename: str
    danger: bool
    alert_level: str    # "high" | "low" | "none"
    distance: str       # "Close" | "Medium" | "Far"
    objects: list[DetectedObject]