import time
import logging
from collections import deque

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
        self._start_time = time.time()

        # Client RTT — end-to-end latency reported by the client
        self.client_rtts = deque(maxlen=window_size)
        # Timestamped history for live chart (last 60 data points)
        self.rtt_history = deque(maxlen=60)

        # Frame arrival timestamps (last 100) — for actual FPS calculation
        self.frame_arrival_times = deque(maxlen=window_size)
        # Client-reported FPS (capture rate at the client side)
        self.client_fps_reports = deque(maxlen=window_size)

    def start_timer(self) -> float:
        """Call at the beginning of a request. Returns timestamp."""
        now = time.time()
        self.frame_arrival_times.append(now)
        return now

    def end_timer(self, start: float, success: bool = True):
        """Call at the end of a request. Records latency and status."""
        latency_ms = (time.time() - start) * 1000
        self.latencies.append(latency_ms)
        self.total_frames += 1

        if success:
            self.success_count += 1
        else:
            self.failure_count += 1

        logger.info(f"Frame processed in {latency_ms:.1f}ms")
        return latency_ms

    # ── Client FPS reporting ─────────────────────────────

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

    def get_client_rtt_stats(self) -> dict:
        """Avg/min/max of client-reported RTT."""
        if not self.client_rtts:
            return {"avg_ms": 0.0, "min_ms": 0.0, "max_ms": 0.0}
        return {
            "avg_ms": round(sum(self.client_rtts) / len(self.client_rtts), 2),
            "min_ms": round(min(self.client_rtts), 2),
            "max_ms": round(max(self.client_rtts), 2),
        }

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

    def get_status(self) -> dict:
        """Full system status report for /get_system_status endpoint."""
        return {
            "uptime_seconds": self.get_uptime(),
            "total_frames": self.total_frames,
            "success_count": self.success_count,
            "failure_count": self.failure_count,
            "server_latency": {
                "avg_ms": self.get_avg_latency(),
                "min_ms": self.get_min_latency(),
                "max_ms": self.get_max_latency()
            },
            "client_rtt": self.get_client_rtt_stats(),
            "rtt_history": list(self.rtt_history),
            "fps": {
                "server_capacity": self.get_recent_fps(),       # תיאורטי - יכולת
                "server_actual":   self.get_actual_server_fps(), # בפועל - מה שנכנס
                "client_actual":   self.get_client_fps()["avg"], # מה שהלקוח שולח
                "overall":         self.get_fps()                # ממוצע על כל הריצה
            }
        }


# Single global instance — shared across the server
tracker = PerformanceTracker()