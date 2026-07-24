"""
ByteTrack-inspired Multi-Object Tracker for SeeSense.

Assigns persistent IDs to detected objects and tracks them across frames.
Uses IoU (Intersection over Union) matching with Hungarian algorithm for
optimal assignment, and two-stage association (high + low confidence).

Each track maintains a history of positions for motion analysis:
approaching, moving away, lateral direction, speed estimation.
"""

import logging
import numpy as np
from collections import deque
from scipy.optimize import linear_sum_assignment

logger = logging.getLogger(__name__)

# ==================== Configuration ====================
MAX_AGE = 10               # Frames to keep a lost track before removing
MIN_HITS = 2               # Minimum detections before track is confirmed
IOU_THRESHOLD = 0.3        # Minimum IoU for matching
LOW_CONF_THRESHOLD = 0.3   # Below this = low confidence detection
HIGH_CONF_THRESHOLD = 0.5  # Above this = high confidence detection
HISTORY_SIZE = 10           # Frames of history per track
APPROACH_RATIO = 1.10       # BBox grew 10%+ across the motion window = approaching
RAPID_APPROACH_RATIO = 1.25 # BBox grew 25%+ = fast approach
LATERAL_THRESHOLD = 15      # Pixels of lateral movement to register direction
MOTION_WINDOW = 4           # Frames to look back for motion (anti-jitter smoothing)

# Per-user tracker instances
_user_trackers = {}


class Track:
    """
    Single tracked object with persistent ID and motion history.
    """
    _next_id = 1

    def __init__(self, detection: dict):
        self.track_id = Track._next_id
        Track._next_id += 1

        self.class_name = detection["class_name"]
        self.confidence = detection["confidence"]
        self.bbox = detection["bbox"]

        # Track lifecycle
        self.age = 0           # Frames since creation
        self.hits = 1          # Times detected
        self.time_since_update = 0  # Frames since last matched

        # Position history for motion analysis
        self.history = deque(maxlen=HISTORY_SIZE)
        self.history.append({
            "bbox": self.bbox,
            "area": _bbox_area(self.bbox),
            "center": _bbox_center(self.bbox)
        })

    def update(self, detection: dict):
        """Update track with new matched detection."""
        self.bbox = detection["bbox"]
        self.confidence = detection["confidence"]
        self.class_name = detection["class_name"]
        self.hits += 1
        self.time_since_update = 0

        self.history.append({
            "bbox": self.bbox,
            "area": _bbox_area(self.bbox),
            "center": _bbox_center(self.bbox)
        })

    def mark_missed(self):
        """Called when track is not matched in current frame."""
        self.time_since_update += 1

    def is_confirmed(self) -> bool:
        """Track has enough hits to be considered real."""
        return self.hits >= MIN_HITS

    def is_dead(self) -> bool:
        """Track has been lost for too long."""
        return self.time_since_update > MAX_AGE

    def get_motion(self) -> dict:
        """
        Analyze motion from position history.

        Uses a WINDOWED comparison (current vs several frames back) rather than
        just the previous frame. YOLO bounding boxes jitter a few pixels every
        frame even on a perfectly static object; comparing frame-to-frame makes
        `approaching` flicker on/off and spam alerts. Comparing across a short
        window smooths that jitter out: a truly static object stays "static",
        and only a sustained size increase (real approach) reads as "approaching".
        """
        if len(self.history) < 2:
            return {
                "track_id": self.track_id,
                "direction": "unknown",
                "approaching": False,
                "speed": "unknown",
                "area_change": 1.0
            }

        curr = self.history[-1]
        # Look back up to WINDOW frames (or as far as history allows early on).
        lookback = min(len(self.history) - 1, MOTION_WINDOW)
        past = self.history[-1 - lookback]

        # Area change across the window (approaching/receding)
        if past["area"] <= 0:
            area_ratio = 1.0
        else:
            area_ratio = curr["area"] / past["area"]

        approaching = area_ratio >= APPROACH_RATIO

        if area_ratio >= RAPID_APPROACH_RATIO:
            speed = "fast"
        elif area_ratio >= APPROACH_RATIO:
            speed = "moderate"
        elif area_ratio <= (1 / APPROACH_RATIO):
            speed = "moving_away"
        else:
            speed = "static"

        # Lateral movement across the same window
        dx = curr["center"][0] - past["center"][0]
        if dx > LATERAL_THRESHOLD:
            direction = "right"
        elif dx < -LATERAL_THRESHOLD:
            direction = "left"
        else:
            direction = "center"

        return {
            "track_id": self.track_id,
            "direction": direction,
            "approaching": approaching,
            "speed": speed,
            "area_change": round(area_ratio, 3)
        }


class ByteTracker:
    """
    ByteTrack-inspired multi-object tracker.

    Two-stage association:
    1. Match high-confidence detections to existing tracks using IoU
    2. Match remaining low-confidence detections to unmatched tracks
    This prevents losing tracks when objects are temporarily occluded.
    """

    def __init__(self):
        self.tracks: list[Track] = []

    def update(self, detections: list[dict]) -> list[dict]:
        """
        Process new frame detections.
        Returns enriched detections with track_id and motion data.
        """
        # Age all tracks
        for track in self.tracks:
            track.age += 1

        if not detections:
            # No detections — mark all tracks as missed
            for track in self.tracks:
                track.mark_missed()
            self._cleanup()
            return []

        # Split detections into high and low confidence
        high_dets = [d for d in detections if d["confidence"] >= HIGH_CONF_THRESHOLD]
        low_dets = [d for d in detections if d["confidence"] < HIGH_CONF_THRESHOLD]

        # Stage 1: Match high-confidence detections to tracks
        matched_track_indices, matched_det_indices, unmatched_tracks, unmatched_dets = \
            self._associate(self.tracks, high_dets)

        # Update matched tracks
        for t_idx, d_idx in zip(matched_track_indices, matched_det_indices):
            self.tracks[t_idx].update(high_dets[d_idx])

        # Stage 2: Match low-confidence detections to remaining unmatched tracks
        remaining_tracks = [self.tracks[i] for i in unmatched_tracks]
        if remaining_tracks and low_dets:
            matched_t2, matched_d2, still_unmatched_tracks, _ = \
                self._associate(remaining_tracks, low_dets)

            for t_idx, d_idx in zip(matched_t2, matched_d2):
                remaining_tracks[t_idx].update(low_dets[d_idx])

            # Mark truly unmatched tracks
            for t_idx in still_unmatched_tracks:
                remaining_tracks[t_idx].mark_missed()
        else:
            for t_idx in unmatched_tracks:
                self.tracks[t_idx].mark_missed()

        # Create new tracks for unmatched high-confidence detections
        for d_idx in unmatched_dets:
            new_track = Track(high_dets[d_idx])
            self.tracks.append(new_track)

        # Remove dead tracks
        self._cleanup()

        # Build enriched output
        enriched = []
        for det in detections:
            # Find the track that owns this detection
            track = self._find_track_for_detection(det)
            motion = track.get_motion() if track else {
                "track_id": -1,
                "direction": "unknown",
                "approaching": False,
                "speed": "unknown",
                "area_change": 1.0
            }
            enriched.append({**det, "motion": motion})

        return enriched

    def _associate(self, tracks: list, detections: list[dict]):
        """
        Match detections to tracks using IoU + Hungarian algorithm.
        Returns matched pairs and unmatched indices.
        """
        if not tracks or not detections:
            return [], [], list(range(len(tracks))), list(range(len(detections)))

        # Build IoU cost matrix
        iou_matrix = np.zeros((len(tracks), len(detections)))
        for t_idx, track in enumerate(tracks):
            for d_idx, det in enumerate(detections):
                iou_matrix[t_idx, d_idx] = _compute_iou(track.bbox, det["bbox"])

        # Hungarian algorithm (minimize cost = maximize IoU)
        cost_matrix = 1 - iou_matrix
        track_indices, det_indices = linear_sum_assignment(cost_matrix)

        # Filter by IoU threshold
        matched_tracks = []
        matched_dets = []
        unmatched_tracks = set(range(len(tracks)))
        unmatched_dets = set(range(len(detections)))

        for t_idx, d_idx in zip(track_indices, det_indices):
            if iou_matrix[t_idx, d_idx] >= IOU_THRESHOLD:
                matched_tracks.append(t_idx)
                matched_dets.append(d_idx)
                unmatched_tracks.discard(t_idx)
                unmatched_dets.discard(d_idx)

        return matched_tracks, matched_dets, list(unmatched_tracks), list(unmatched_dets)

    def _find_track_for_detection(self, detection: dict) -> Track | None:
        """Find the track that best matches this detection by IoU."""
        best_track = None
        best_iou = 0
        for track in self.tracks:
            if track.class_name != detection["class_name"]:
                continue
            iou = _compute_iou(track.bbox, detection["bbox"])
            if iou > best_iou:
                best_iou = iou
                best_track = track
        return best_track if best_iou > 0.5 else None

    def _cleanup(self):
        """Remove dead tracks."""
        before = len(self.tracks)
        self.tracks = [t for t in self.tracks if not t.is_dead()]
        removed = before - len(self.tracks)
        if removed > 0:
            logger.debug(f"Removed {removed} dead tracks")


# ==================== Utility Functions ====================

def _bbox_area(bbox: list) -> float:
    x1, y1, x2, y2 = bbox
    return max(0, x2 - x1) * max(0, y2 - y1)


def _bbox_center(bbox: list) -> tuple:
    x1, y1, x2, y2 = bbox
    return ((x1 + x2) / 2, (y1 + y2) / 2)


def _compute_iou(bbox1: list, bbox2: list) -> float:
    """Compute Intersection over Union between two bounding boxes."""
    x1 = max(bbox1[0], bbox2[0])
    y1 = max(bbox1[1], bbox2[1])
    x2 = min(bbox1[2], bbox2[2])
    y2 = min(bbox1[3], bbox2[3])

    intersection = max(0, x2 - x1) * max(0, y2 - y1)

    area1 = _bbox_area(bbox1)
    area2 = _bbox_area(bbox2)
    union = area1 + area2 - intersection

    if union == 0:
        return 0.0

    return intersection / union


# ==================== Public Interface ====================

def get_tracker(user_id: str) -> ByteTracker:
    """Get or create ByteTracker for a user."""
    if user_id not in _user_trackers:
        _user_trackers[user_id] = ByteTracker()
    return _user_trackers[user_id]


def clear_tracker(user_id: str):
    """Clear tracking history for a user."""
    _user_trackers.pop(user_id, None)