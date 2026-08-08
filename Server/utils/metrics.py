import time
import logging
from collections import deque, defaultdict

logger = logging.getLogger(__name__)

class PerformanceTracker:

    def __init__(self, window_size: int = 100):
        self.window_size = window_size
        self.latencies = deque(maxlen=window_size)
        self.success_latencies = deque(maxlen=window_size)
        self.total_frames = 0
        self.success_count = 0
        self.failure_count = 0
        self.reject_count = 0
        self.error_count = 0
        self.lost_count = 0
        self._start_time = time.time()

        self.client_rtts = deque(maxlen=window_size)
        self.client_base_rtts = deque(maxlen=window_size)
        self.frame_bytes = deque(maxlen=window_size)
        self.rtt_history = deque(maxlen=60)

        self.client_e2es = deque(maxlen=window_size)
        self.client_e2e_min = None
        self.client_e2e_max = None

        self.frame_arrival_times = deque(maxlen=window_size)
        self.client_fps_reports = deque(maxlen=window_size)

        self.throughput_events = deque(maxlen=1000)

        self.stage_latencies = defaultdict(lambda: deque(maxlen=window_size))

        self.client_stages = {}
        self.last_input_size = None
        self.last_stream_config = None

    def reset(self):
        self.latencies.clear()
        self.success_latencies.clear()
        self.total_frames = 0
        self.success_count = 0
        self.failure_count = 0
        self.reject_count = 0
        self.error_count = 0
        self.lost_count = 0
        self._start_time = time.time()
        self.client_rtts.clear()
        self.client_base_rtts.clear()
        self.client_e2es.clear()
        self.client_e2e_min = None
        self.client_e2e_max = None
        self.frame_bytes.clear()
        self.rtt_history.clear()
        self.frame_arrival_times.clear()
        self.client_fps_reports.clear()
        self.stage_latencies.clear()
        self.throughput_events.clear()
        self.client_stages = {}
        logger.info("PerformanceTracker reset — all live metrics cleared")

    def start_timer(self) -> float:
        now = time.perf_counter()
        self.frame_arrival_times.append(now)
        return now

    def end_timer(self, start: float, success: bool = True, outcome: str | None = None):
        latency_ms = (time.perf_counter() - start) * 1000
        self.latencies.append(latency_ms)
        self.total_frames += 1

        if success:
            self.success_count += 1
            self.success_latencies.append(latency_ms)
            self.throughput_events.append(time.time())
        else:
            self.failure_count += 1
            if outcome == "reject":
                self.reject_count += 1
            elif outcome == "error":
                self.error_count += 1

        logger.debug(f"Frame processed in {latency_ms:.1f}ms")
        return latency_ms

    def record_input_size(self, size: int):
        try:
            self.last_input_size = int(size)
        except (TypeError, ValueError):
            pass

    def record_stream_config(self, cfg: dict):
        if isinstance(cfg, dict):
            self.last_stream_config = dict(cfg)

    def record_client_fps(self, fps: float):
        self.client_fps_reports.append(fps)

    def get_client_fps(self) -> dict:
        if not self.client_fps_reports:
            return {"avg": 0.0, "current": 0.0}
        return {
            "avg": round(sum(self.client_fps_reports) / len(self.client_fps_reports), 2),
            "current": round(self.client_fps_reports[-1], 2),
        }

    def get_actual_server_fps(self) -> float:
        if len(self.frame_arrival_times) < 2:
            return 0.0
        time_span = self.frame_arrival_times[-1] - self.frame_arrival_times[0]
        if time_span <= 0:
            return 0.0
        return round((len(self.frame_arrival_times) - 1) / time_span, 2)

    def record_client_rtt(self, rtt_ms: float):
        self.client_rtts.append(rtt_ms)
        self.rtt_history.append({
            "ts": round(time.time() * 1000),
            "rtt": round(rtt_ms, 1)
        })

    def record_client_base_rtt(self, rtt_ms: float):
        self.client_base_rtts.append(rtt_ms)

    def record_client_e2e(self, avg_ms: float, min_ms: float | None = None,
                          max_ms: float | None = None):
        self.client_e2es.append(avg_ms)
        if min_ms is not None:
            self.client_e2e_min = (min_ms if self.client_e2e_min is None
                                   else min(self.client_e2e_min, min_ms))
        if max_ms is not None:
            self.client_e2e_max = (max_ms if self.client_e2e_max is None
                                   else max(self.client_e2e_max, max_ms))

    def record_lost(self, n: int):
        try:
            n = int(n)
        except (TypeError, ValueError):
            return
        if 0 < n < 100000:
            self.lost_count += n

    def record_frame_bytes(self, n: int):
        self.frame_bytes.append(int(n))

    def get_frame_bytes(self) -> dict:
        if not self.frame_bytes:
            return {"avg_kb": 0.0, "min_kb": 0.0, "max_kb": 0.0}
        return {
            "avg_kb": round(sum(self.frame_bytes) / len(self.frame_bytes) / 1024, 1),
            "min_kb": round(min(self.frame_bytes) / 1024, 1),
            "max_kb": round(max(self.frame_bytes) / 1024, 1),
        }

    def get_client_rtt_stats(self) -> dict:
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

    def get_client_e2e_stats(self) -> dict:
        if not self.client_e2es:
            return {"avg_ms": 0.0, "min_ms": 0.0, "max_ms": 0.0}
        return {
            "avg_ms": round(sum(self.client_e2es) / len(self.client_e2es), 2),
            "min_ms": round(self.client_e2e_min, 2) if self.client_e2e_min is not None else 0.0,
            "max_ms": round(self.client_e2e_max, 2) if self.client_e2e_max is not None else 0.0,
        }

    def record_stage(self, stage: str, ms: float):
        self.stage_latencies[stage].append(ms)

    def get_stage_breakdown(self) -> dict:
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

    def record_client_stages(self, stages: dict):
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

    def get_avg_latency(self) -> float:
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
        uptime = time.time() - self._start_time
        if uptime == 0:
            return 0.0
        return round(self.total_frames / uptime, 2)

    def get_recent_fps(self) -> float:
        if len(self.success_latencies) < 2:
            return 0.0
        avg_latency_sec = (sum(self.success_latencies) / len(self.success_latencies)) / 1000
        if avg_latency_sec == 0:
            return 0.0
        return round(1.0 / avg_latency_sec, 2)

    def get_uptime(self) -> float:
        return round(time.time() - self._start_time, 2)

    def get_throughput(self, window_seconds: float = 10.0) -> dict:
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
            "client_e2e": self.get_client_e2e_stats(),
            "rtt_history": list(self.rtt_history),
            "stage_latency": self.get_stage_breakdown(),
            "client_stage_latency": self.client_stages,
            "input_size": self.last_input_size,
            "stream_config": self.last_stream_config,
            "frame_bytes": self.get_frame_bytes(),
            "throughput": self.get_throughput(),
            "fps": {
                "server_capacity": self.get_recent_fps(),
                "server_actual":   self.get_actual_server_fps(),
                "client_actual":   self.get_client_fps()["avg"],
                "overall":         self.get_fps()
            }
        }

tracker = PerformanceTracker()