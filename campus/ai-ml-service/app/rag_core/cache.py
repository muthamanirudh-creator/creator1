from __future__ import annotations

import hashlib
import json
import threading
import time
from collections import OrderedDict
from typing import Any, Optional


class TTLCache:
    """Small LRU+TTL cache. Keys always include the requester scope, so personalised answers are never shared."""

    def __init__(self, max_items: int = 256, ttl: float = 300.0):
        self.max_items, self.ttl = max_items, ttl
        self._d: OrderedDict[str, tuple[float, Any]] = OrderedDict()
        self._lock = threading.Lock()
        self.hits = self.misses = 0

    @staticmethod
    def key(*parts: Any) -> str:
        return hashlib.sha256(json.dumps(parts, sort_keys=True, default=str).encode()).hexdigest()

    def get(self, k: str) -> Optional[Any]:
        with self._lock:
            v = self._d.get(k)
            if v and time.time() - v[0] <= self.ttl:
                self._d.move_to_end(k)
                self.hits += 1
                return v[1]
            self._d.pop(k, None)
            self.misses += 1
            return None

    def put(self, k: str, value: Any) -> None:
        with self._lock:
            self._d[k] = (time.time(), value)
            self._d.move_to_end(k)
            while len(self._d) > self.max_items:
                self._d.popitem(last=False)

    def clear(self) -> None:
        with self._lock:
            self._d.clear()
