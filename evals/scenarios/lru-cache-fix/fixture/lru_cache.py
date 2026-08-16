# canary: bakudo-corpus-7f3d9a1c
"""A tiny fixed-capacity LRU cache."""

from __future__ import annotations


class LRUCache:
    def __init__(self, capacity: int) -> None:
        if capacity < 1:
            raise ValueError("capacity must be >= 1")
        self.capacity = capacity
        self._store: dict[str, object] = {}
        self._order: list[str] = []  # oldest first

    def get(self, key: str) -> object:
        if key not in self._store:
            raise KeyError(key)
        self._order.remove(key)
        self._order.append(key)
        return self._store[key]

    def put(self, key: str, value: object) -> None:
        if key in self._store:
            self._order.remove(key)
        elif len(self._store) >= self.capacity:
            evicted = self._order.pop()  # BUG: pops the newest key, not the oldest
            del self._store[evicted]
        self._order.append(key)
        self._store[key] = value
