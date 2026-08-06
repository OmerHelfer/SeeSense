import time
import logging
from collections import deque, defaultdict

logger = logging.getLogger(__name__)


class PerformanceTracker:
    """
    Tracks server performance metrics:
    - Request latency (per frame — server-side processing only)
    - Client RTT (end-to-end round trip reported by the client)
    - FPS (frames processed per second)
    - Total frames processed
    - Success/failure counts

    Uses a sliding window (last 100 requests) for averages.
    """

    def __init__(self, window_size: int = 100):
        self.window_size = window_size
        self.latencies = deque(maxlen=window_size)
        self.total_frames = 0
        self.success_count = 0
        self.failure_count = 0
        # failure_count split by cause. A blurry photo and a server bug are both
        # "a frame that didn't work", but they demand completely different
        # responses — one is the world being difficult, the other is us being
        # broken — so a single counter hid the only distinction that mattered.
        self.reject_count = 0   # arrived, failed a quality check (blur/dark/covered/small)
        self.error_count = 0    # arrived, raised an unexpected exception
        # Sent by the client but never answered. Measured on the PHONE (the server
        # cannot count what never reached it) and reported periodically.
        self.lost_count = 0
        self._start_time = time.time()

        # Client RTT — end-to-end latency reported by the client
        self.client_rtts = deque(maxlen=window_size)
        # BASE RTT — the client's tiny /health ping (a few bytes each way). With no
        # payload worth transmitting it is essentially two one-way propagations, so
        # it is the reference that lets the frame RTT be split into an outbound leg
        # (which carries the ~40-70 KB JPEG) and a return leg (a small JSON).
        self.client_base_rtts = deque(maxlen=window_size)
        # Compressed size of the frames actually arriving, in bytes. The whole point
        # of the compression setting is to move this number, and without it the
        # outbound-leg estimate can't be read as "cost per KB".
        self.frame_bytes = deque(maxlen=window_size)
        # Timestamped history for live chart (last 60 data points)
        self.rtt_history = deque(maxlen=60)

        # Frame arrival timestamps (last 100) — for actual FPS calculation
        self.frame_arrival_times = deque(maxlen=window_size)
        # Client-reported FPS (capture rate at the client side)
        self.client_fps_reports = deque(maxlen=window_size)

        # Completion timestamps of SUCCESSFULLY processed frames — for throughput
        # (real useful output rate over a short recent wall-clock window). Unlike the
        # FPS numbers above this is not diluted by long idle gaps: it decays to 0 when
        # nothing is being processed and reflects "how many detections/sec are flowing
        # right now". Kept generous so a full window still fits at high FPS.
        self.throughput_events = deque(maxlen=1000)

        # Stage-level breakdown of where server_latency actually goes —
        # decode_quality, inference, tracking, logic, db_write.
        self.stage_latencies = defaultdict(lambda: deque(maxlen=window_size))

        # Latest CLIENT-side stage breakdown (capture/encode/render/feedback). The
        # client aggregates its own per-frame timings and reports the avg/min/max
        # every few seconds, so we just keep the most recent snapshot — never on any
        # hot path. {stage: {avg_ms,min_ms,max_ms}}.
        self.client_stages = {}
        # Square input size the most recent connection actually negotiated. Lives
        # in the client bundle (streamConfig.js) but is clamped server-side, so
        # this is the only place the EFFECTIVE value is knowable — a stale or
        # cached client bundle otherwise silently keeps sending the old size.
        self.last_input_size = None

    def reset(self):
        """
        Wipe ALL live metrics and restart timing from now. Backs the admin 'reset'
        button — clears the in-memory sliding windows so the live view reflects only
        what happens after the reset. (Persisted history is dropped separately via
        perf_history.reset_history.)
        """
        self.latencies.clear()
        self.total_frames = 0
        self.success_count = 0
        self.failure_count = 0
        self.reject_count = 0
        self.error_count = 0
        self.lost_count = 0
        self._start_time = time.time()
        self.client_rtts.clear()
        self.client_base_rtts.clear()
        self.frame_bytes.clear()
        self.rtt_history.clear()
        self.frame_arrival_times.clear()
        self.client_fps_reports.clear()
        self.stage_latencies.clear()
        self.throughput_events.clear()
        self.client_stages = {}
        logger.info("PerformanceTracker reset — all live metrics cleared")

    def start_timer(self) -> float:
        """
        Call at the beginning of a request. Returns a timestamp.

        perf_counter, not time(): the wall clock can be stepped by NTP mid-frame,
        which would poison a latency sample (and it has coarser resolution on
        Windows). Only differences are ever taken from these values —
        frame_arrival_times is used purely for a rate — so a monotonic clock with
        an arbitrary origin is the right one. throughput_events below is the one
        exception and stays on the wall clock, because it is compared against
        time.time() when the recent-window throughput is computed.
        """
        now = time.perf_counter()
        self.frame_arrival_times.append(now)
        return now

    def end_timer(self, start: float, success: bool = True, outcome: str | None = None):
        """Call at the end of a request. Records latency and status.

        `outcome` refines a failure into "reject" (failed a quality check) or
        "error" (raised). Omitted, it is derived from `success`, so existing
        callers keep working and only lose the finer classification.
        """
        latency_ms = (time.perf_counter() - start) * 1000
        self.latencies.append(latency_ms)
        self.total_frames += 1

        if success:
            self.success_count += 1
            self.throughput_events.append(time.time())
        else:
            self.failure_count += 1
            if outcome == "reject":
                self.reject_count += 1
            elif outcome == "error":
                self.error_count += 1

        # DEBUG, not INFO. This runs once per frame: at 25 FPS it was 25 formatted
        # log lines a second written to stdout from inside the frame loop, and in a
        # container stdout is a pipe — when the collector is slow that write blocks
        # the event loop serving the WebSocket. It also logged a number measured
        # before the line itself, so it never showed its own cost.
        logger.debug(f"Frame processed in {latency_ms:.1f}ms")
        return latency_ms

    # ── Client FPS reporting ─────────────────────────────

    def record_input_size(self, size: int):
        """Note the input size a connection negotiated (called on WS connect)."""
        try:
            self.last_input_size = int(size)
        except (TypeError, ValueError):
            pass

    def record_client_fps(self, fps: float):
        """Record the actual capture rate reported by the client."""
        self.client_fps_reports.append(fps)

    def get_client_fps(self) -> dict:
        """Average client capture FPS (sliding window)."""
        if not self.client_fps_reports:
            return {"avg": 0.0, "current": 0.0}
        return {
            "avg": round(sum(self.client_fps_reports) / len(self.client_fps_reports), 2),
            "current": round(self.client_fps_reports[-1], 2),
        }

    def get_actual_server_fps(self) -> float:
        """Real server processing rate based on frame arrival timestamps in window."""
        if len(self.frame_arrival_times) < 2:
            return 0.0
        time_span = self.frame_arrival_times[-1] - self.frame_arrival_times[0]
        if time_span <= 0:
            return 0.0
        return round((len(self.frame_arrival_times) - 1) / time_span, 2)

    # ── Client RTT reporting ─────────────────────────────

    def record_client_rtt(self, rtt_ms: float):
        """Record a client-reported round-trip time measurement."""
        self.client_rtts.append(rtt_ms)
        self.rtt_history.append({
            "ts": round(time.time() * 1000),  # epoch ms for JS
            "rtt": round(rtt_ms, 1)
        })

    def record_client_base_rtt(self, rtt_ms: float):
        """Record the client's tiny-payload /health ping RTT (the propagation floor)."""
        self.client_base_rtts.append(rtt_ms)

    def record_lost(self, n: int):
        """Frames the client sent that never came back, as a delta since its last
        report. Untrusted client input, so clamp it: a bad or hostile client must
        not be able to poison the counter with a single huge number."""
        try:
            n = int(n)
        except (TypeError, ValueError):
            return
        if 0 < n < 100000:
            self.lost_count += n

    def record_frame_bytes(self, n: int):
        """Record the compressed size of one arriving frame."""
        self.frame_bytes.append(int(n))

    def get_frame_bytes(self) -> dict:
        """Avg/min/max compressed frame size, in KB."""
        if not self.frame_bytes:
            return {"avg_kb": 0.0, "min_kb": 0.0, "max_kb": 0.0}
        return {
            "avg_kb": round(sum(self.frame_bytes) / len(self.frame_bytes) / 1024, 1),
            "min_kb": round(min(self.frame_bytes) / 1024, 1),
            "max_kb": round(max(self.frame_bytes) / 1024, 1),
        }

    def get_client_rtt_stats(self) -> dict:
        """Avg/min/max of client-reported RTT, plus the small-payload base RTT."""
        base = (round(sum(self.client_base_rtts) / len(self.client_base_rtts), 2)
                if self.client_base_rtts else 0.0)
        if not self.client_rtts:
            return {"avg_ms": 0.0, "min_ms": 0.0, "max_ms": 0.0, "base_ms": base}
        return {
            "avg_ms": round(sum(self.client_rtts) / len(self.client_rtts), 2),
            "min_ms": round(min(self.client_rtts), 2),
            "max_ms": round(max(self.client_rtts), 2),
            "base_ms": base,
        }

    # ── Stage-level latency breakdown ────────────────────

    def record_stage(self, stage: str, ms: float):
        """Record how long one pipeline stage took for this frame (ms)."""
        self.stage_latencies[stage].append(ms)

    def get_stage_breakdown(self) -> dict:
        """Avg/min/max per pipeline stage — only successful-frame stages are recorded,
        so this reflects real processing cost, not diluted by instantly-rejected frames."""
        breakdown = {}
        for stage, values in self.stage_latencies.items():
            if not values:
                continue
            breakdown[stage] = {
                "avg_ms": round(sum(values) / len(values), 2),
                "min_ms": round(min(values), 2),
                "max_ms": round(max(values), 2),
            }
        return breakdown

    # ── Client-side stage breakdown (reported by the client) ─────────────

    def record_client_stages(self, stages: dict):
        """Store the latest client-side stage breakdown (capture/encode/render/feedback).
        The client sends already-aggregated avg/min/max per stage over its own rolling
        window every few seconds; we keep the most recent snapshot. Defensive: this is
        untrusted client input, so validate/clamp and ignore anything malformed. Never
        runs on the frame hot path (only on the periodic report message)."""
        if not isinstance(stages, dict):
            return
        cleaned = {}
        for stage, v in list(stages.items())[:16]:
            if not isinstance(v, dict):
                continue
            try:
                avg = float(v.get("avg"))
                mn = float(v.get("min"))
                mx = float(v.get("max"))
            except (TypeError, ValueError):
                continue
            if not all(0 <= x < 60000 for x in (avg, mn, mx)):
                continue
            cleaned[str(stage)[:32]] = {
                "avg_ms": round(avg, 2),
                "min_ms": round(mn, 2),
                "max_ms": round(mx, 2),
            }
        if cleaned:
            self.client_stages = cleaned

    # ── Server latency stats ─────────────────────────────

    def get_avg_latency(self) -> float:
        """Average latency over sliding window (ms)."""
        if not self.latencies:
            return 0.0
        return round(sum(self.latencies) / len(self.latencies), 2)

    def get_min_latency(self) -> float:
        if not self.latencies:
            return 0.0
        return round(min(self.latencies), 2)

    def get_max_latency(self) -> float:
        if not self.latencies:
            return 0.0
        return round(max(self.latencies), 2)

    def get_fps(self) -> float:
        """Average FPS based on total uptime."""
        uptime = time.time() - self._start_time
        if uptime == 0:
            return 0.0
        return round(self.total_frames / uptime, 2)

    def get_recent_fps(self) -> float:
        """FPS based on last N requests in the sliding window."""
        if len(self.latencies) < 2:
            return 0.0
        avg_latency_sec = (sum(self.latencies) / len(self.latencies)) / 1000
        if avg_latency_sec == 0:
            return 0.0
        return round(1.0 / avg_latency_sec, 2)

    def get_uptime(self) -> float:
        """Server uptime in seconds."""
        return round(time.time() - self._start_time, 2)

    def get_throughput(self, window_seconds: float = 10.0) -> dict:
        """
        Real throughput: SUCCESSFULLY processed frames per second, measured from the
        completion timestamps within the last `window_seconds` of wall-clock time.
        This is the "useful output rate flowing right now": because only recent events
        count, it decays to 0 when idle — so (unlike server_actual / overall FPS) it is
        NOT distorted by long idle gaps between test bursts.

        Rate is derived from the actual span between the recent events
        ((n-1)/(t_last - t_first)), the same jitter-free method get_actual_server_fps
        uses, so it reads correctly immediately during steady scanning without a
        warm-up ramp. Needs ≥2 events in the window to report a rate.
        """
        now = time.time()
        cutoff = now - window_seconds
        recent = [t for t in self.throughput_events if t >= cutoff]
        if len(recent) < 2:
            return {"per_second": 0.0, "window_seconds": window_seconds,
                    "frames_in_window": len(recent)}
        span = recent[-1] - recent[0]
        per_second = round((len(recent) - 1) / span, 2) if span > 0 else 0.0
        return {
            "per_second": per_second,
            "window_seconds": window_seconds,
            "frames_in_window": len(recent),
        }

    def get_status(self) -> dict:
        """Full system status report for /get_system_status endpoint."""
        return {
            "uptime_seconds": self.get_uptime(),
            "total_frames": self.total_frames,
            "success_count": self.success_count,
            "failure_count": self.failure_count,
            "reject_count": self.reject_count,
            "error_count": self.error_count,
            "lost_count": self.lost_count,
            "server_latency": {
                "avg_ms": self.get_avg_latency(),
                "min_ms": self.get_min_latency(),
                "max_ms": self.get_max_latency()
            },
            "client_rtt": self.get_client_rtt_stats(),
            "rtt_history": list(self.rtt_history),
            "stage_latency": self.get_stage_breakdown(),
            "client_stage_latency": self.client_stages,
            "input_size": self.last_input_size,
            "frame_bytes": self.get_frame_bytes(),
            "throughput": self.get_throughput(),
            "fps": {
                "server_capacity": self.get_recent_fps(),       # תיאורטי - יכולת
                "server_actual":   self.get_actual_server_fps(), # בפועל - מה שנכנס
                "client_actual":   self.get_client_fps()["avg"], # מה שהלקוח שולח
                "overall":         self.get_fps()                # ממוצע על כל הריצה
            }
        }


# Single global instance — shared across the server
tracker = PerformanceTracker()