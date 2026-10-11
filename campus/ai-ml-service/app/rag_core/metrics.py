"""Privacy-conscious metrics: counts and latencies only - never query text, resumes or answers."""
from __future__ import annotations

import threading
from collections import defaultdict, deque


class Metrics:
    def __init__(self, window: int = 500):
        self._lock = threading.Lock()
        self.counters: dict[str, int] = defaultdict(int)
        self._lat: dict[str, deque] = defaultdict(lambda: deque(maxlen=window))
        self.tokens_in = self.tokens_out = 0

    def inc(self, name: str, n: int = 1) -> None:
        with self._lock:
            self.counters[name] += n

    def observe(self, name: str, ms: float) -> None:
        with self._lock:
            self._lat[name].append(ms)

    def tokens(self, tin: int, tout: int) -> None:
        with self._lock:
            self.tokens_in += tin
            self.tokens_out += tout

    def snapshot(self) -> dict:
        with self._lock:
            lat = {}
            for k, v in self._lat.items():
                s = sorted(v)
                if s:
                    lat[k] = {"n": len(s), "p50_ms": round(s[len(s) // 2], 1), "p95_ms": round(s[min(len(s) - 1, int(len(s) * 0.95))], 1)}
            return {"counters": dict(self.counters), "latency": lat, "approx_tokens_in": self.tokens_in, "approx_tokens_out": self.tokens_out}


METRICS = Metrics()
