from pydantic import BaseModel


class DetectedObject(BaseModel):
    class_name: str
    confidence: float
    bbox: list[float]
    area_ratio: float
    distance: str       # "Close" | "Medium" | "Far"
    alert_level: str    # "high" | "low" | "none"


class AnalyzeFrameResponse(BaseModel):
    status: str
    filename: str
    danger: bool
    alert_level: str    # "high" | "low" | "none"
    distance: str       # "Close" | "Medium" | "Far"
    objects: list[DetectedObject]