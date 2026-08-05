"""
Simulation harness for SeeSense approach detection.

Generates physically realistic detection sequences (pinhole camera: apparent size
= f * real_size / distance) and runs them through the real ByteTracker +
assess_danger, so tuning is done against evidence instead of by eye.

Every scenario is run at several frame rates, because the deployed FPS ranges from
~40 indoors to ~9 on a congested cellular link — a detector tuned in frames would
behave completely differently at each.

Usage:  python approach_harness.py
"""
import importlib
import random
import sys

sys.path.insert(0, r"c:\Users\omer3\OneDrive\Desktop\SeeSense-main\SeeSense\Server")

import logging
logging.disable(logging.CRITICAL)

FRAME_PX = 640
FOV_DEG = 60.0
# Pinhole focal length in pixels for the frame width / field of view above.
FOCAL_PX = FRAME_PX / (2 * __import__("math").tan(__import__("math").radians(FOV_DEG / 2)))

HIGH_RISK = {"car", "person", "dog", "stairs", "pole", "bicycle", "motorcycle"}


def bbox_at(distance_m, real_size_m, center_frac=0.5, jitter=0.0, rng=None):
    """Bounding box for an object of a given real size at a given distance."""
    px = FOCAL_PX * real_size_m / max(distance_m, 0.05)
    if jitter and rng:
        px *= rng.uniform(1 - jitter, 1 + jitter)
    cx = FRAME_PX * center_frac
    cy = FRAME_PX * 0.5
    half = px / 2
    return [cx - half, cy - half, cx + half, cy + half]


class Scenario:
    """A scripted motion path plus what the system is expected to do about it."""

    def __init__(self, name, cls, real_size_m, path, expect_alert, note="",
                 jitter=0.02, center=lambda t: 0.5, dropout=()):
        self.name = name
        self.cls = cls
        self.real_size_m = real_size_m
        self.path = path              # t (seconds) -> distance in metres
        self.expect_alert = expect_alert
        self.note = note
        self.jitter = jitter
        self.center = center
        self.dropout = dropout        # (start_s, end_s) with no detections

    def run(self, fps, duration_s, seed=1):
        """Feed the scenario through the real tracker + danger logic."""
        from services.motion_tracker import ByteTracker
        from services.logic_service import assess_danger

        rng = random.Random(seed)
        tr = ByteTracker()
        dt = 1.0 / fps
        n = int(duration_s * fps)

        # The tracker's window is wall-clock based, so drive its clock rather than
        # sleeping — otherwise a 30s scenario takes 30s to evaluate.
        import services.motion_tracker as mt
        virtual = {"t": 0.0}
        real_monotonic = mt.time.monotonic
        mt.time.monotonic = lambda: virtual["t"]

        levels, first_alert_t, cleared_t = [], None, None
        first_low_t, first_appr_t = None, None
        try:
            for i in range(n):
                t = i * dt
                virtual["t"] = t
                muted = any(a <= t <= b for a, b in self.dropout)
                dets = []
                if not muted:
                    d = self.path(t)
                    dets = [{
                        "class_name": self.cls,
                        "confidence": 0.9,
                        "bbox": bbox_at(d, self.real_size_m, self.center(t), self.jitter, rng),
                    }]
                enriched = tr.update(dets)
                res = assess_danger(enriched, high_risk_classes=HIGH_RISK,
                                    image_width=FRAME_PX, image_height=FRAME_PX)
                lvl = res["alert_level"]
                levels.append(lvl)
                if enriched and enriched[0].get("motion", {}).get("approaching") and first_appr_t is None:
                    first_appr_t = t
                if lvl in ("low", "high") and first_low_t is None:
                    first_low_t = t
                if lvl == "high" and first_alert_t is None:
                    first_alert_t = t
                if first_alert_t is not None and lvl == "none" and cleared_t is None:
                    cleared_t = t
        finally:
            mt.time.monotonic = real_monotonic

        return {
            "first_low_t": first_low_t,
            "first_appr_t": first_appr_t,
            "levels": levels,
            "first_alert_t": first_alert_t,
            "cleared_t": cleared_t,
            "high_frames": sum(1 for l in levels if l == "high"),
            "low_frames": sum(1 for l in levels if l == "low"),
            "none_frames": sum(1 for l in levels if l == "none"),
        }


def scenarios():
    return [
        Scenario("dog approaching 1.0 m/s from 5m", "dog", 0.5,
                 lambda t: max(0.4, 5.0 - 1.0 * t), True,
                 "called your dog — MUST alert"),
        Scenario("dog approaching SLOWLY 0.4 m/s from 4m", "dog", 0.5,
                 lambda t: max(0.4, 4.0 - 0.4 * t), True,
                 "slow steady approach — the case that stayed blue"),
        Scenario("person walking at you 1.4 m/s from 8m", "person", 1.7,
                 lambda t: max(0.5, 8.0 - 1.4 * t), True),
        Scenario("YOU walk toward a parked car 1.2 m/s from 8m", "car", 1.5,
                 lambda t: max(0.6, 8.0 - 1.2 * t), True,
                 "user moves, object static — must still alert"),
        Scenario("car approaching FAST 8 m/s from 25m", "car", 1.5,
                 lambda t: max(1.0, 25.0 - 8.0 * t), True),

        Scenario("STATIC dog at 2m (jitter 2%)", "dog", 0.5,
                 lambda t: 2.0, False, "sitting with your dog — must stay silent",
                 jitter=0.02),
        Scenario("STATIC dog at 1.2m (jitter 5%)", "dog", 0.5,
                 lambda t: 1.2, False, "close + noisy detection — must stay silent",
                 jitter=0.05),
        Scenario("STATIC car at 3m (jitter 3%)", "car", 1.5,
                 lambda t: 3.0, False, "parked car — must stay silent", jitter=0.03),
        Scenario("object MOVING AWAY 1 m/s", "dog", 0.5,
                 lambda t: 1.5 + 1.0 * t, False),
        Scenario("person CROSSING sideways at 3m", "person", 1.7,
                 lambda t: 3.0, False, "constant distance, lateral only",
                 center=lambda t: min(0.95, 0.05 + 0.3 * t)),

        Scenario("approach with DETECTION DROPOUT", "dog", 0.5,
                 lambda t: max(0.4, 5.0 - 1.0 * t), True,
                 "occluded 1.5-2.0s mid-approach — must still alert",
                 dropout=((1.5, 2.0),)),
        Scenario("approach then STOP at t=3s", "dog", 0.5,
                 lambda t: max(1.5, 5.0 - 1.0 * t) if t < 3.5 else 1.5, True,
                 "must alert, then CLEAR after it stops"),
    ]


def main():
    import services.motion_tracker, services.logic_service
    importlib.reload(services.motion_tracker)
    importlib.reload(services.logic_service)

    rates = [40, 9]
    print(f"{'scenario':<40}{'expect':>7}", end="")
    for f in rates:
        print(f"{'  @'+str(f)+'fps appr/yellow/red':>30}", end="")
    print()
    print("-" * (47 + 30 * len(rates)))

    failures = []
    for sc in scenarios():
        print(f"{sc.name:<40}{'ALERT' if sc.expect_alert else 'silent':>7}", end="")
        for fps in rates:
            r = sc.run(fps, duration_s=8.0)
            f = lambda v: f"{v:.2f}" if v is not None else "--"
            cell = f"{f(r['first_appr_t'])}/{f(r['first_low_t'])}/{f(r['first_alert_t'])}"
            ok = (r["first_low_t"] is not None) if sc.expect_alert else (r["first_low_t"] is None)
            if not ok:
                failures.append((sc.name, fps, cell))
            print(f"{cell:>30}", end="")
        print(f"   {sc.note}" if sc.note else "")

    print()
    if failures:
        print(f"FAILURES ({len(failures)}):")
        for name, fps, cell in failures:
            print(f"  {fps:>3} FPS  {name:<44} {cell}")
    else:
        print("ALL SCENARIOS PASS")

    # Clearing behaviour on the stop scenario
    sc = [s for s in scenarios() if "STOP" in s.name][0]
    print("\nclear-after-stop (object halts at t=3.5s):")
    for fps in rates:
        r = sc.run(fps, duration_s=8.0)
        c = r["cleared_t"]
        print(f"  {fps:>3} FPS: alert@{r['first_alert_t']}, cleared@{c}"
              f"{'  -> ' + format(c - 3.5, '.2f') + 's after stopping' if c and c > 3.5 else ''}")


if __name__ == "__main__":
    main()
