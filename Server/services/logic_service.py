import logging

from core.config import (
    FRAME_AREA,
    CONFIDENCE_THRESHOLD,
    BBOX_AREA_CLOSE_RATIO,
    BBOX_AREA_MEDIUM_RATIO,
    HIGH_RISK_CLASSES,
)

logger = logging.getLogger(__name__)


def assess_danger(detections: list[dict], high_risk_classes: set = None) -> dict:
    """
    Takes standardized detections and returns danger assessment.
    
    Args:
        detections: list of detection dicts
        high_risk_classes: optional custom set of classes the user considers dangerous.
                          Falls back to config default if not provided.
    """
    if high_risk_classes is None:
        high_risk_classes = HIGH_RISK_CLASSES
    if not detections:
        return {
            "danger": False,
            "alert_level": "none",
            "distance": "Far",
            "objects": []
        }

    processed_objects = []
    highest_alert = "none"
    closest_distance = "Far"

    for det in detections:
        class_name = det.get("class_name", "unknown")
        confidence = det.get("confidence", 0.0)
        bbox = det.get("bbox", [0, 0, 0, 0])

        if confidence < CONFIDENCE_THRESHOLD:
            continue

        bbox_area = _calc_bbox_area(bbox)
        area_ratio = bbox_area / FRAME_AREA
        distance = _classify_distance(area_ratio)
        motion = det.get("motion", {})
        alert_level = _classify_alert(class_name, distance, high_risk_classes, motion)

        processed_objects.append({
            "class_name": class_name,
            "confidence": round(confidence, 3),
            "bbox": bbox,
            "area_ratio": round(area_ratio, 4),
            "distance": distance,
            "alert_level": alert_level,
            "motion": motion
        })

        if _alert_priority(alert_level) > _alert_priority(highest_alert):
            highest_alert = alert_level

        if _distance_priority(distance) > _distance_priority(closest_distance):
            closest_distance = distance

    danger = highest_alert == "high"

    logger.info(
        f"Danger assessment: danger={danger}, alert={highest_alert}, "
        f"closest={closest_distance}, objects={len(processed_objects)}"
    )

    return {
        "danger": danger,
        "alert_level": highest_alert,
        "distance": closest_distance,
        "objects": processed_objects
    }


def _calc_bbox_area(bbox: list) -> float:
    x1, y1, x2, y2 = bbox
    return max(0, x2 - x1) * max(0, y2 - y1)


def _classify_distance(area_ratio: float) -> str:
    if area_ratio >= BBOX_AREA_CLOSE_RATIO:
        return "Close"
    elif area_ratio >= BBOX_AREA_MEDIUM_RATIO:
        return "Medium"
    return "Far"


def _classify_alert(class_name: str, distance: str, high_risk_classes: set, motion: dict = None) -> str:
    is_high_risk = class_name in high_risk_classes
    approaching = motion.get("approaching", False) if motion else False
    speed = motion.get("speed", "unknown") if motion else "unknown"

    # Fast approaching high-risk object → always high, even if medium distance
    if is_high_risk and approaching and speed == "fast":
        return "high"

    # Standard rules
    if is_high_risk and distance == "Close":
        return "high"

    # Approaching high-risk at medium distance → escalate to high
    if is_high_risk and distance == "Medium" and approaching:
        return "high"

    if is_high_risk and distance == "Medium":
        return "low"

    # Non-high-risk but approaching and close
    if distance == "Close" and approaching:
        return "high"

    if distance == "Close":
        return "low"

    return "none"


def _alert_priority(level: str) -> int:
    return {"none": 0, "low": 1, "high": 2}.get(level, 0)


def _distance_priority(distance: str) -> int:
    return {"Far": 0, "Medium": 1, "Close": 2}.get(distance, 0)