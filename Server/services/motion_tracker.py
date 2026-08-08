
import logging
import time
import numpy as np
from collections import deque
from scipy.optimize import linear_sum_assignment

logger = logging.getLogger(__name__)

MAX_AGE_SECONDS   = 1.2
MIN_HITS          = 3
SMOOTH_N          = 3
HISTORY_SIZE      = 48

IOU_THRESHOLD       = 0.3
HIGH_CONF_THRESHOLD = 0.5

APPROACH_WINDOW_SEC  = 0.8
APPROACH_MIN_SAMPLES = 5

ENTER_GROWTH = 0.045
ENTER_SNR    = 2.2
EXIT_GROWTH  = 0.015
EXIT_SNR     = 1.0

CONFIRM_SEC = 0.30
RELEASE_SEC = 0.25

RAPID_TIME_TO_CONTACT_SEC = 3.0
RAPID_GROWTH_PER_SEC = 1.0 / RAPID_TIME_TO_CONTACT_SEC

LATERAL_THRESHOLD = 15
BBOX_SMOOTHING    = 0.4

_NO_MOTION = {
    "track_id": -1,
    "direction": "unknown",
    "approaching": False,
    "speed": "unknown",
    "area_change": 1.0,
}

_user_trackers = {}


def _median(values):
    s = sorted(values)
    n = len(s)
    if n == 0:
        return 0.0
    mid = n // 2
    return s[mid] if n % 2 else (s[mid - 1] + s[mid]) / 2.0


def _size_trend(window):
    n = len(window)
    ts = [h["t"] for h in window]
    ys = [h["area"] ** 0.5 for h in window]

    mean_t = sum(ts) / n
    mean_y = sum(ys) / n
    if mean_y <= 0:
        return 0.0, 0.0, 0.0

    sxx = sum((t - mean_t) ** 2 for t in ts)
    if sxx <= 0:
        return 0.0, 0.0, 0.0
    sxy = sum((t - mean_t) * (y - mean_y) for t, y in zip(ts, ys))
    slope = sxy / sxx

    residuals = [y - (mean_y + slope * (t - mean_t)) for t, y in zip(ts, ys)]
    resid_rms = (sum(r * r for r in residuals) / n) ** 0.5

    span = ts[-1] - ts[0]
    change = slope * span

    growth = change / mean_y
    rate = slope / mean_y
    snr = abs(change) / resid_rms if resid_rms > 1e-9 else (99.0 if change else 0.0)
    return growth, snr, rate


class Track:
    _next_id = 1

    def __init__(self, detection: dict):
        self.track_id = Track._next_id
        Track._next_id += 1

        self.class_name = detection["class_name"]
        self.confidence = detection["confidence"]
        self.bbox = list(detection["bbox"])

        self.age = 0
        self.hits = 1
        self.time_since_update = 0
        self.last_seen = time.monotonic()

        self.approaching = False
        self._grow_since = None
        self._flat_since = None

        self.history = deque(maxlen=HISTORY_SIZE)
        self._push_history()

    def _push_history(self):
        self.history.append({
            "t": time.monotonic(),
            "bbox": list(self.bbox),
            "area": _bbox_area(self.bbox),
            "center": _bbox_center(self.bbox),
        })

    def update(self, detection: dict):
        a = BBOX_SMOOTHING
        self.bbox = [a * r + (1 - a) * p for r, p in zip(detection["bbox"], self.bbox)]
        self.confidence = detection["confidence"]
        self.hits += 1
        self.time_since_update = 0
        self.last_seen = time.monotonic()
        self._push_history()

    def mark_missed(self):
        self.time_since_update += 1

    def is_confirmed(self) -> bool:
        return self.hits >= MIN_HITS

    def is_dead(self) -> bool:
        return (time.monotonic() - self.last_seen) > MAX_AGE_SECONDS

    def get_motion(self) -> dict:
        if not self.is_confirmed() or len(self.history) < 2:
            return {**_NO_MOTION, "track_id": self.track_id}

        now = self.history[-1]["t"]
        window = [h for h in self.history if h["t"] >= now - APPROACH_WINDOW_SEC]

        if len(window) < APPROACH_MIN_SAMPLES:
            return {**_NO_MOTION, "track_id": self.track_id, "speed": "static"}

        growth, snr, rate = _size_trend(window)

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

        if self.approaching and rate >= RAPID_GROWTH_PER_SEC:
            speed = "fast"
        elif self.approaching:
            speed = "moderate"
        elif growth <= -EXIT_GROWTH:
            speed = "moving_away"
        else:
            speed = "static"

        area_ratio = (1.0 + growth) ** 2

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

    def __init__(self):
        self.tracks: list[Track] = []

    def update(self, detections: list[dict]) -> list[dict]:
        for track in self.tracks:
            track.age += 1

        if not detections:
            for track in self.tracks:
                track.mark_missed()
            self._cleanup()
            return []

        indexed = list(enumerate(detections))
        high = [(i, d) for i, d in indexed if d["confidence"] >= HIGH_CONF_THRESHOLD]
        low  = [(i, d) for i, d in indexed if d["confidence"] <  HIGH_CONF_THRESHOLD]
        owner: dict[int, Track] = {}

        m_t, m_d, un_t, un_d = self._associate(self.tracks, [d for _, d in high])
        for t_idx, d_idx in zip(m_t, m_d):
            self.tracks[t_idx].update(high[d_idx][1])
            owner[high[d_idx][0]] = self.tracks[t_idx]

        remaining = [self.tracks[i] for i in un_t]
        if remaining and low:
            m_t2, m_d2, still_un, _ = self._associate(remaining, [d for _, d in low])
            for t_idx, d_idx in zip(m_t2, m_d2):
                remaining[t_idx].update(low[d_idx][1])
                owner[low[d_idx][0]] = remaining[t_idx]

            for t_idx in still_un:
                remaining[t_idx].mark_missed()
        else:
            for t_idx in un_t:
                self.tracks[t_idx].mark_missed()

        for d_idx in un_d:
            orig_i, det = high[d_idx]
            track = Track(det)
            self.tracks.append(track)
            owner[orig_i] = track

        self._cleanup()

        enriched = []
        for i, det in indexed:
            track = owner.get(i)
            if track:
                enriched.append({
                    **det,
                    "bbox": list(track.bbox),
                    "motion": track.get_motion(),
                })
            else:
                enriched.append({**det, "motion": dict(_NO_MOTION)})

        return enriched

    def _associate(self, tracks: list, detections: list[dict]):
        if not tracks or not detections:
            return [], [], list(range(len(tracks))), list(range(len(detections)))

        iou_matrix = np.zeros((len(tracks), len(detections)))
        for t_idx, track in enumerate(tracks):
            for d_idx, det in enumerate(detections):
                if track.class_name != det["class_name"]:
                    continue
                iou_matrix[t_idx, d_idx] = _compute_iou(track.bbox, det["bbox"])

        cost_matrix = 1 - iou_matrix
        track_indices, det_indices = linear_sum_assignment(cost_matrix)

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
        before = len(self.tracks)
        self.tracks = [t for t in self.tracks if not t.is_dead()]
        removed = before - len(self.tracks)
        if removed > 0:
            logger.debug(f"Removed {removed} dead tracks")



def _bbox_area(bbox: list) -> float:
    x1, y1, x2, y2 = bbox
    return max(0, x2 - x1) * max(0, y2 - y1)


def _bbox_center(bbox: list) -> tuple:
    x1, y1, x2, y2 = bbox
    return ((x1 + x2) / 2, (y1 + y2) / 2)


def _compute_iou(bbox1: list, bbox2: list) -> float:
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



def get_tracker(user_id: str) -> ByteTracker:
    if user_id not in _user_trackers:
        _user_trackers[user_id] = ByteTracker()
    return _user_trackers[user_id]


def clear_tracker(user_id: str):
    _user_trackers.pop(user_id, None)
