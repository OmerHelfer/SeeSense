from pydantic import BaseModel
from typing import Optional


class MotionData(BaseModel):
    track_id: int = -1
    direction: str = "unknown"
    approaching: bool = False
    speed: str = "unknown"
    area_change: Optional[float] = None


class DetectedObject(BaseModel):
    class_name: str
    confidence: float
    bbox: list[float]
    area_ratio: float
    distance: str
    position: str = "center"
    alert_level: str
    alert_message: str = ""
    motion: Optional[MotionData] = None


class AnalyzeFrameResponse(BaseModel):
    status: str
    filename: str
    danger: bool
    danger_cleared: bool = False
    clearance_message: Optional[str] = None
    alert_is_new: bool = False
    alert_level: str
    distance: str
    objects: list[DetectedObject]