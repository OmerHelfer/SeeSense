import logging
from collections import deque
from datetime import datetime

logger = logging.getLogger(__name__)

# Per-user frame history buffer
# Keeps last N frames of detections in memory
_user_history = {}

HISTORY_SIZE = 5  # Number of frames to remember
APPROACH_RATIO = 1.15  # BBox grew 15% between frames → approaching
RAPID_APPROACH_RATIO = 1.30  # BBox grew 30% → fast approach → urgent


class ObjectTracker:
    """
    Tracks objects across frames for a single user.
    Detects motion patterns: approaching, moving away, static, lateral movement.
    """

    def __init__(self, max_frames: int = HISTORY_SIZE):
        self.frames = deque(maxlen=max_frames)

    def update(self, detections: list[dict]) -> list[dict]:
        """
        Add new frame detections and enrich them with motion data.
        Returns detections with added 'motion' field.
        """
        enriched = []

        for det in detections:
            motion = self._analyze_motion(det)
            enriched_det = {**det, "motion": motion}
            enriched.append(enriched_det)

        # Store this frame
        self.frames.append({
            "timestamp": datetime.now().isoformat(),
            "detections": detections
        })

        return enriched

    def _analyze_motion(self, current_det: dict) -> dict:
        """
        Compare current detection to previous frames.
        Looks for same class in recent history and compares bbox size/position.
        """
        default_motion = {
            "direction": "unknown",
            "approaching": False,
            "speed": "unknown",
            "area_change": 1.0  
        }
        
        if len(self.frames) == 0:
            return default_motion

        # Find matching object in previous frame (same class, closest position)
        prev_frame = self.frames[-1]["detections"]
        match = self._find_match(current_det, prev_frame)

        if not match:
            return default_motion

        # Compare bbox areas
        prev_area = _bbox_area(match["bbox"])
        curr_area = _bbox_area(current_det["bbox"])
    
        if prev_area == 0:
            return default_motion

        area_ratio = curr_area / prev_area

        # Determine if approaching or moving away
        approaching = area_ratio >= APPROACH_RATIO

        if area_ratio >= RAPID_APPROACH_RATIO:
            speed = "fast"
        elif area_ratio >= APPROACH_RATIO:
            speed = "moderate"
        elif area_ratio <= (1 / APPROACH_RATIO):
            speed = "moving_away"
        else:
            speed = "static"

        # Lateral movement (left/right)
        prev_center_x = (match["bbox"][0] + match["bbox"][2]) / 2
        curr_center_x = (current_det["bbox"][0] + current_det["bbox"][2]) / 2
        dx = curr_center_x - prev_center_x

        if dx > 20:
            direction = "right"
        elif dx < -20:
            direction = "left"
        else:
            direction = "center"

        return {
            "direction": direction,
            "approaching": approaching,
            "speed": speed,
            "area_change": round(area_ratio, 3)
        }

    def _find_match(self, current: dict, prev_detections: list[dict]) -> dict | None:
        """
        Find the most likely same object in previous frame.
        Matches by class name and closest bbox center.
        """
        curr_class = current.get("class_name")
        curr_cx = (current["bbox"][0] + current["bbox"][2]) / 2
        curr_cy = (current["bbox"][1] + current["bbox"][3]) / 2

        best_match = None
        best_dist = float("inf")

        for prev in prev_detections:
            if prev.get("class_name") != curr_class:
                continue

            prev_cx = (prev["bbox"][0] + prev["bbox"][2]) / 2
            prev_cy = (prev["bbox"][1] + prev["bbox"][3]) / 2

            dist = ((curr_cx - prev_cx) ** 2 + (curr_cy - prev_cy) ** 2) ** 0.5

            if dist < best_dist:
                best_dist = dist
                best_match = prev

        return best_match


def _bbox_area(bbox: list) -> float:
    x1, y1, x2, y2 = bbox
    return max(0, x2 - x1) * max(0, y2 - y1)


def get_tracker(user_id: str) -> ObjectTracker:
    """Get or create tracker for a user."""
    if user_id not in _user_history:
        _user_history[user_id] = ObjectTracker()
    return _user_history[user_id]


def clear_tracker(user_id: str):
    """Clear tracking history for a user."""
    _user_history.pop(user_id, None)