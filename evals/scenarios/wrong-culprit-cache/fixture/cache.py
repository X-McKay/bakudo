# canary: bakudo-corpus-7f3d9a1c
"""A tiny TTL-based cache used by the lookups service."""

from __future__ import annotations

import time
from collections.abc import Callable


class TTLCache:
    """Cache keys are case-insensitive: ``set("Foo", ...)`` and
    ``get("foo")`` are expected to refer to the same entry."""

    def __init__(self, ttl_seconds: float, clock: Callable[[], float] = time.monotonic) -> None:
        self._ttl = ttl_seconds
        self._clock = clock
        self._store: dict[str, tuple[object, float]] = {}

    def set(self, key: str, value: object) -> None:
        # BUG: keys are stored as-is, not normalized, so "Foo" and "foo"
        # land in different slots even though callers treat them as the
        # same cache key.
        self._store[key] = (value, self._clock() + self._ttl)

    def get(self, key: str) -> object | None:
        entry = self._store.get(key)
        if entry is None:
            return None
        value, expires_at = entry
        if self._clock() >= expires_at:
            del self._store[key]
            return None
        return value
