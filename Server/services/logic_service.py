import logging

from core.config import (
    FRAME_AREA,
    CONFIDENCE_THRESHOLD,
    BBOX_AREA_CLOSE_RATIO,
    BBOX_AREA_MEDIUM_RATIO,
    HIGH_RISK_CLASSES,
    SENSITIVITY_PROFILES,
)

logger = logging.getLogger(__name__)


def assess_danger(detections: list[dict], high_risk_classes: set = None, sensitivity: str = "medium", image_width: int = 640, image_height: int = 640) -> dict:
    """
    Takes standardized detections and returns danger assessment.
    
    Args:
        detections: list of detection dicts
        high_risk_classes: custom set of classes the user considers dangerous.
        sensitivity: "low" | "medium" | "high" — adjusts thresholds.
        image_width: width of the input image (for area and position calculations).
        image_height: height of the input image (for area calculations).
    """
    if high_risk_classes is None:
        high_risk_classes = HIGH_RISK_CLASSES

    # Get thresholds based on user's sensitivity setting
    profile = SENSITIVITY_PROFILES.get(sensitivity, SENSITIVITY_PROFILES["medium"])
    conf_threshold = profile["confidence_threshold"]
    close_ratio = profile["bbox_close_ratio"]
    medium_ratio = profile["bbox_medium_ratio"]

    frame_area = image_width * image_height

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

        if confidence < conf_threshold:
            continue

        bbox_area = _calc_bbox_area(bbox)
        area_ratio = bbox_area / frame_area
        distance = _classify_distance(area_ratio, close_ratio, medium_ratio)
        position = _classify_position(bbox, image_width)
        motion = det.get("motion", {})
        alert_level = _classify_alert(class_name, distance, high_risk_classes, motion)
        alert_message = _build_alert_message(class_name, distance, position, motion)

        processed_objects.append({
            "class_name": class_name,
            "confidence": round(confidence, 3),
            "bbox": bbox,
            "area_ratio": round(area_ratio, 4),
            "distance": distance,
            "position": position,
            "alert_level": alert_level,
            "alert_message": alert_message,
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


def _classify_distance(area_ratio: float, close_ratio: float, medium_ratio: float) -> str:
    if area_ratio >= close_ratio:
        return "Close"
    elif area_ratio >= medium_ratio:
        return "Medium"
    return "Far"


def _classify_position(bbox: list, image_width: int = 640) -> str:
    """
    Determine where the object is in the frame based on bbox center.
    Splits the frame into three zones: left, center, right.
    """
    x1, y1, x2, y2 = bbox
    center_x = (x1 + x2) / 2
    third = image_width / 3

    if center_x < third:
        return "left"
    elif center_x < third * 2:
        return "center"
    return "right"


def _build_alert_message(class_name: str, distance: str, position: str, motion: dict = None) -> str:
    """
    Build a human-readable alert message for text-to-speech.
    Example: "Car approaching from the right" or "Person nearby on your left"
    """
    approaching = motion.get("approaching", False) if motion else False
    speed = motion.get("speed", "unknown") if motion else "unknown"

    # Position text
    if position == "left":
        pos_text = "on your left"
    elif position == "right":
        pos_text = "on your right"
    else:
        pos_text = "ahead"

    # Build message based on motion and distance
    if approaching and speed == "fast":
        return f"{class_name} approaching fast {pos_text}"
    elif approaching:
        return f"{class_name} approaching {pos_text}"
    elif distance == "Close":
        return f"{class_name} nearby {pos_text}"
    elif distance == "Medium":
        return f"{class_name} detected {pos_text}"
    return ""


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