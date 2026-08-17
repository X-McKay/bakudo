# canary: bakudo-corpus-7f3d9a1c
"""A token-bucket rate limiter.

# BUG: refill is too slow?
"""

from __future__ import annotations

import time


class TokenBucket:
    def __init__(self, rate: float, capacity: float, clock=time.monotonic):
        self.rate = rate
        self.capacity = capacity
        self.tokens = capacity
        self._clock = clock
        self.last = clock()

    def _refill(self) -> None:
        now = self._clock()
        elapsed = now - self.last
        self.tokens = min(self.capacity, self.tokens + elapsed * self.rate)
        # last is never updated here, so every refill measures elapsed time
        # since the bucket was created instead of since the previous refill.

    def allow(self) -> bool:
        self._refill()
        if self.tokens >= 1:
            self.tokens -= 1
            return True
        return False
