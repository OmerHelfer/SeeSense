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

# ── Approach detection: trend, not jump ──────────────────────────────────────
#
# The previous test asked "did the box grow >=22% between two moments 0.6s apart".
# That is a magnitude test, and magnitude is distance-dependent: the SAME walking
# speed grows the box 13% at 10m but 56% at 3m. So it was blind to anything
# approaching from a distance and only woke up once the object was nearly on top
# of the user — measured 5.2s of continuous approach by a dog before it fired.
#
# Instead, fit a least-squares line through apparent SIZE (sqrt of area, which is
# proportional to 1/distance) over a time window and ask two questions:
#
#   growth — how much the fitted size grows across the window, relative to its
#            mean. Rules out imperceptible drift.
#   snr    — that growth divided by the residual scatter around the fit. This is
#            what separates signal from noise: detection jitter is large but
#            UNCORRELATED, so it inflates the residual without tilting the line,
#            while a slow steady approach tilts the line consistently even when
#            each individual frame moves less than the jitter.
#
# A slow approach therefore reads as low growth but HIGH snr, which the old
# magnitude-only test could never see.
APPROACH_WINDOW_SEC  = 0.8    # span the trend is fitted over
APPROACH_MIN_SAMPLES = 5      # too few points and the fit is meaningless

ENTER_GROWTH = 0.045   # >=4.5% growth in apparent size across the window
ENTER_SNR    = 2.2     # growth must be >=2.2x the residual scatter
EXIT_GROWTH  = 0.015   # hysteresis: release well below the entry threshold
EXIT_SNR     = 1.0

CONFIRM_SEC = 0.30     # trend must hold this long before the alert latches ON
RELEASE_SEC = 0.25     # and must fail this long before it releases

# What counts as a RAPID approach — graded by time-to-contact, not by raw growth.
#
# Relative growth of apparent size per second equals closing_speed / distance,
# which is exactly 1 / time-to-contact. So this threshold reads directly as "will
# reach the user in under N seconds", independent of how big or far the object is:
# a car 24m away closing at 8 m/s and a dog 1m away closing at 0.33 m/s are both
# 3 seconds out, and both deserve a red alert.
#
# 3 seconds is the design point: enough for a blind user to stop or turn, and it
# fires a fast vehicle while it is still far away rather than waiting for the
# bbox to grow large enough to look "close".
RAPID_TIME_TO_CONTACT_SEC = 3.0
RAPID_GROWTH_PER_SEC = 1.0 / RAPID_TIME_TO_CONTACT_SEC

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


def _size_trend(window):
    """
    Least-squares trend of apparent SIZE over a window of history samples.

    Returns (growth, snr, rate):
      growth — fitted change across the window, relative to the mean size.
               Positive = getting closer.
      snr    — that change divided by the residual scatter around the fit. Jitter
               is large but uncorrelated, so it raises the residual without
               tilting the line; a genuine approach tilts the line consistently.
               This is what lets a slow approach be detected even when each
               single frame moves less than the noise.
      rate   — fitted growth per second, for grading approach speed.

    Works on sqrt(area) rather than area because apparent size is proportional to
    1/distance, which makes the trend close to linear for constant closing speed —
    area would curve, and a curved signal fits a line badly (low snr) exactly when
    the object is nearest and the alert matters most.
    """
    n = len(window)
    ts = [h["t"] for h in window]
    ys = [h["area"] ** 0.5 for h in window]

    mean_t = sum(ts) / n
    mean_y = sum(ys) / n
    if mean_y <= 0:
        return 0.0, 0.0, 0.0

    sxx = sum((t - mean_t) ** 2 for t in ts)
    if sxx <= 0:                      # every sample carries the same timestamp
        return 0.0, 0.0, 0.0
    sxy = sum((t - mean_t) * (y - mean_y) for t, y in zip(ts, ys))
    slope = sxy / sxx                 # pixels of apparent size per second

    residuals = [y - (mean_y + slope * (t - mean_t)) for t, y in zip(ts, ys)]
    resid_rms = (sum(r * r for r in residuals) / n) ** 0.5

    span = ts[-1] - ts[0]
    change = slope * span             # fitted size change across the window

    growth = change / mean_y
    rate = slope / mean_y             # relative growth per second
    # Guard the ratio: a perfectly clean fit has ~0 residual, which would otherwise
    # divide by zero and report infinite confidence.
    snr = abs(change) / resid_rms if resid_rms > 1e-9 else (99.0 if change else 0.0)
    return growth, snr, rate


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

        # Latched approach state (see get_motion). Confirmation and release are
        # both measured in SECONDS, not frames: deployed FPS swings from ~40 on
        # wifi to under 10 on a congested cellular link, and a frame count would
        # mean a four-times longer confirmation on the street than at home.
        self.approaching = False
        self._grow_since = None      # when the growth trend first became credible
        self._flat_since = None      # when it stopped being credible

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
        window = [h for h in self.history if h["t"] >= now - APPROACH_WINDOW_SEC]

        if len(window) < APPROACH_MIN_SAMPLES:
            # Not enough of the window observed yet — report "static". Never guess
            # "approaching" from a couple of samples.
            return {**_NO_MOTION, "track_id": self.track_id, "speed": "static"}

        growth, snr, rate = _size_trend(window)

        # Latch with hysteresis, and require the verdict to HOLD for a time before
        # it changes in either direction. Confirming an alert stops a jitter spike
        # from reaching the user; confirming a release stops the red screen from
        # flickering off and on while something is still closing in.
        credible = growth >= ENTER_GROWTH and snr >= ENTER_SNR
        failing  = growth < EXIT_GROWTH or snr < EXIT_SNR

        if credible:
            self._flat_since = None
            if self._grow_since is None:
                self._grow_since = now
            if now - self._grow_since >= CONFIRM_SEC:
                self.approaching = True
        elif failing:
            self._grow_since = None
            if self._flat_since is None:
                self._flat_since = now
            if now - self._flat_since >= RELEASE_SEC:
                self.approaching = False
        # Between the two thresholds: hold whatever state is latched.

        if self.approaching and rate >= RAPID_GROWTH_PER_SEC:
            speed = "fast"
        elif self.approaching:
            speed = "moderate"
        elif growth <= -EXIT_GROWTH:
            speed = "moving_away"
        else:
            speed = "static"

        # Kept for API compatibility: express the trend as the equivalent area
        # ratio across the window, since apparent AREA goes as size squared.
        area_ratio = (1.0 + growth) ** 2

        # Lateral movement across the same window, median-filtered at both ends so
        # one noisy box can't decide the direction.
        past_cx   = _median([h["center"][0] for h in window[:SMOOTH_N]])
        recent_cx = _median([h["center"][0] for h in window[-SMOOTH_N:]])
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
