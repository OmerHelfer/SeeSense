"""
ByteTrack-inspired Multi-Object Tracker for SeeSense.

Assigns persistent IDs to detected objects and tracks them across frames.
Uses IoU (Intersection over Union) matching with Hungarian algorithm for
optimal assignment, and two-stage association (high + low confidence).

Each track maintains a history of positions for motion analysis:
approaching, moving away, lateral direction, speed estimation.

Motion analysis is deliberately conservative, because a false "approaching" turns
straight into a red danger alert with voice + haptics. Every knob here errs
towards silence:
  - timings are in SECONDS, not frames (frame counts were tuned at ~4 FPS and
    silently became 10x tighter when TARGET_FPS went to 40);
  - both ends of the motion window are median-filtered, so one noisy box can't
    decide the verdict;
  - `approaching` is latched with hysteresis + a confirmation streak, so it can't
    chatter on/off around a single threshold;
  - an unconfirmed or under-sampled track reports no motion at all.
"""

import logging
import time
import numpy as np
from collections import deque
from scipy.optimize import linear_sum_assignment

logger = logging.getLogger(__name__)

# ==================== Configuration ====================
# All motion timings are durations, so they stay correct at any frame rate.
MAX_AGE_SECONDS   = 1.2    # keep a lost track (and its ID) alive this long
MOTION_WINDOW_SEC = 0.6    # look-back span for the approach test
MIN_HITS          = 3      # detections before a track may report motion at all
SMOOTH_N          = 3      # samples median-filtered at each end of the window
HISTORY_SIZE      = 48     # must cover MOTION_WINDOW_SEC at 40 FPS

IOU_THRESHOLD       = 0.3  # minimum IoU for matching
HIGH_CONF_THRESHOLD = 0.5  # at/above this = high confidence detection

# Hysteresis: latch ON above ENTER, release only below EXIT. A single threshold
# makes `approaching` chatter, and every chatter reaches the user as an alert.
# 1.22 area growth is ~10% linear growth — outside YOLO's per-frame jitter floor.
APPROACH_ENTER_RATIO    = 1.22
APPROACH_EXIT_RATIO     = 1.08
RAPID_APPROACH_RATIO    = 1.45
APPROACH_CONFIRM_FRAMES = 3   # sustained growth required before latching

LATERAL_THRESHOLD = 15     # pixels of lateral movement to register direction
BBOX_SMOOTHING    = 0.4    # EMA factor for the reported box (1.0 = raw, no smoothing)

# Returned for any detection with no owning track. track_id -1 must never be used
# as a dedup key — see services/session_service.has_new_alert.
_NO_MOTION = {
    "track_id": -1,
    "direction": "unknown",
    "approaching": False,
    "speed": "unknown",
    "area_change": 1.0,
}

# Per-user tracker instances
_user_trackers = {}


def _median(values):
    """Median of a short list (cheaper than a numpy round-trip for 3 elements)."""
    s = sorted(values)
    n = len(s)
    if n == 0:
        return 0.0
    mid = n // 2
    return s[mid] if n % 2 else (s[mid - 1] + s[mid]) / 2.0


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
        self.bbox = list(detection["bbox"])

        # Track lifecycle
        self.age = 0                # Frames since creation
        self.hits = 1               # Times detected
        self.time_since_update = 0  # Frames since last matched
        self.last_seen = time.monotonic()

        # Latched approach state (hysteresis — see get_motion)
        self.approaching = False
        self._approach_streak = 0

        # Position history for motion analysis
        self.history = deque(maxlen=HISTORY_SIZE)
        self._push_history()

    def _push_history(self):
        """Record the current (smoothed) box with a wall-clock stamp, so the motion
        window can be a real duration instead of a frame count."""
        self.history.append({
            "t": time.monotonic(),
            "bbox": list(self.bbox),
            "area": _bbox_area(self.bbox),
            "center": _bbox_center(self.bbox),
        })

    def update(self, detection: dict):
        """Update track with new matched detection."""
        # EMA-smooth the box. Raw YOLO boxes jitter a few px every frame, which is
        # what makes both `approaching` AND the Close/Medium distance class flap.
        # Smoothing here fixes both at once (and steadies the client overlay).
        a = BBOX_SMOOTHING
        self.bbox = [a * r + (1 - a) * p for r, p in zip(detection["bbox"], self.bbox)]
        self.confidence = detection["confidence"]
        # class_name is deliberately NOT overwritten — association is class-gated,
        # so a track keeps one identity for its whole life. Letting it flip made a
        # person's area history compare against a car's box (ratio ~3x → "fast").
        self.hits += 1
        self.time_since_update = 0
        self.last_seen = time.monotonic()
        self._push_history()

    def mark_missed(self):
        """Called when track is not matched in current frame."""
        self.time_since_update += 1

    def is_confirmed(self) -> bool:
        """Track has enough hits to be considered real."""
        return self.hits >= MIN_HITS

    def is_dead(self) -> bool:
        """Track has been lost for too long (wall-clock, so it doesn't shrink to a
        quarter of a second when the frame rate rises)."""
        return (time.monotonic() - self.last_seen) > MAX_AGE_SECONDS

    def get_motion(self) -> dict:
        """
        Analyze motion from position history.

        Uses a fixed-DURATION look-back rather than a fixed number of frames, and
        median-filters both ends of the window. YOLO bounding boxes jitter a few
        pixels every frame even on a perfectly static object; comparing two single
        frames a short distance apart measures that jitter, not motion, and a
        false `approaching` is a red danger alert. The verdict is then latched
        with hysteresis so it cannot flicker across the threshold.
        """
        # Silence until the track has proven itself. MIN_HITS existed but was never
        # enforced, so one-frame flickers emitted motion immediately.
        if not self.is_confirmed() or len(self.history) < 2:
            return {**_NO_MOTION, "track_id": self.track_id}

        now = self.history[-1]["t"]
        cutoff = now - MOTION_WINDOW_SEC
        past   = [h for h in self.history if h["t"] <= cutoff]
        recent = [h for h in self.history if h["t"] > cutoff]

        if not past or len(recent) < 2:
            # Window not filled yet — report "static", never guess "approaching".
            return {**_NO_MOTION, "track_id": self.track_id, "speed": "static"}

        # Median over the samples nearest each end of the window.
        past_area = _median([h["area"] for h in past[-SMOOTH_N:]])
        curr_area = _median([h["area"] for h in recent[-SMOOTH_N:]])
        area_ratio = (curr_area / past_area) if past_area > 0 else 1.0

        # Hysteresis + confirmation streak: growth must be sustained to latch on,
        # and must fall well back before it releases.
        if area_ratio >= APPROACH_ENTER_RATIO:
            self._approach_streak += 1
        elif area_ratio < APPROACH_EXIT_RATIO:
            self._approach_streak = 0
            self.approaching = False
        if self._approach_streak >= APPROACH_CONFIRM_FRAMES:
            self.approaching = True

        if self.approaching and area_ratio >= RAPID_APPROACH_RATIO:
            speed = "fast"
        elif self.approaching:
            speed = "moderate"
        elif area_ratio <= (1 / APPROACH_ENTER_RATIO):
            speed = "moving_away"
        else:
            speed = "static"

        # Lateral movement across the same window, also median-filtered.
        past_cx   = _median([h["center"][0] for h in past[-SMOOTH_N:]])
        recent_cx = _median([h["center"][0] for h in recent[-SMOOTH_N:]])
        dx = recent_cx - past_cx
        if dx > LATERAL_THRESHOLD:
            direction = "right"
        elif dx < -LATERAL_THRESHOLD:
            direction = "left"
        else:
            direction = "center"

        return {
            "track_id": self.track_id,
            "direction": direction,
            "approaching": self.approaching,
            "speed": speed,
            "area_change": round(area_ratio, 3),
        }


class ByteTracker:
    """
    ByteTrack-inspired multi-object tracker.

    Two-stage association:
    1. Match high-confidence detections to existing tracks using IoU
    2. Match remaining low-confidence detections to unmatched tracks
    This prevents losing tracks when objects are temporarily occluded.

    Track ownership is recorded DURING association, so every matched detection
    carries its real track_id. (A previous second-pass IoU search used a stricter
    threshold than association itself, so detections in between silently fell
    through to track_id -1 — and every one of those then collided on a single
    dedup key downstream, re-firing alerts on every frame.)
    """

    def __init__(self):
        self.tracks: list[Track] = []

    def update(self, detections: list[dict]) -> list[dict]:
        """
        Process new frame detections.
        Returns enriched detections with track_id, motion data, and the track's
        smoothed bbox.
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

        # Carry the original index so tracks can be attributed back to detections
        # without a second, threshold-mismatched IoU search.
        indexed = list(enumerate(detections))
        high = [(i, d) for i, d in indexed if d["confidence"] >= HIGH_CONF_THRESHOLD]
        low  = [(i, d) for i, d in indexed if d["confidence"] <  HIGH_CONF_THRESHOLD]
        owner: dict[int, Track] = {}

        # Stage 1: high-confidence detections → existing tracks
        m_t, m_d, un_t, un_d = self._associate(self.tracks, [d for _, d in high])
        for t_idx, d_idx in zip(m_t, m_d):
            self.tracks[t_idx].update(high[d_idx][1])
            owner[high[d_idx][0]] = self.tracks[t_idx]

        # Stage 2: low-confidence detections → still-unmatched tracks
        remaining = [self.tracks[i] for i in un_t]
        if remaining and low:
            m_t2, m_d2, still_un, _ = self._associate(remaining, [d for _, d in low])
            for t_idx, d_idx in zip(m_t2, m_d2):
                remaining[t_idx].update(low[d_idx][1])
                owner[low[d_idx][0]] = remaining[t_idx]

            # Mark truly unmatched tracks
            for t_idx in still_un:
                remaining[t_idx].mark_missed()
        else:
            for t_idx in un_t:
                self.tracks[t_idx].mark_missed()

        # Create new tracks for unmatched high-confidence detections
        for d_idx in un_d:
            orig_i, det = high[d_idx]
            track = Track(det)
            self.tracks.append(track)
            owner[orig_i] = track

        # Remove dead tracks
        self._cleanup()

        # Build enriched output
        enriched = []
        for i, det in indexed:
            track = owner.get(i)
            if track:
                # Emit the SMOOTHED box so distance classification (Close/Medium/Far)
                # and the client overlay both stop shimmering with YOLO's jitter.
                enriched.append({
                    **det,
                    "bbox": list(track.bbox),
                    "motion": track.get_motion(),
                })
            else:
                enriched.append({**det, "motion": dict(_NO_MOTION)})

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
                # Never match across classes. Without this a `person` track can
                # absorb an overlapping `car` detection, and the area history then
                # compares a person's box against a car's → ratio ~3x → "fast
                # approach" → a red alert with nothing actually moving.
                if track.class_name != det["class_name"]:
                    continue
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
