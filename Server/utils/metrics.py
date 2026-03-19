import time
import logging
from collections import deque

logger = logging.getLogger(__name__)


class PerformanceTracker:
    """
    Tracks server performance metrics:
    - Request latency (per frame)
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

    def start_timer(self) -> float:
        """Call at the beginning of a request. Returns timestamp."""
        return time.time()

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
            "latency": {
                "avg_ms": self.get_avg_latency(),
                "min_ms": self.get_min_latency(),
                "max_ms": self.get_max_latency()
            },
            "fps": {
                "overall": self.get_fps(),
                "recent": self.get_recent_fps()
            }
        }


# Single global instance — shared across the server
tracker = PerformanceTracker()