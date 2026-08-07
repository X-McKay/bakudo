"""Memory stores: an in-memory reference plus a Postgres+FalkorDB adapter.

The :class:`MemoryStore` protocol is what the control plane depends on. The
in-memory implementation is used by tests and for control-plane reasoning; the
:class:`PgSemanticMemoryStore` (in ``store_pg.py``) is the durable implementation.

Writes always pass through :func:`bakudo.memory.policy.validate_memory_candidate`
first — unverified memories never become facts.
"""

from __future__ import annotations

from typing import Protocol

from .models import MemoryItem
from .policy import MemoryRejected, validate_memory_candidate


class MemoryStore(Protocol):
    def write_candidate(self, item: MemoryItem) -> MemoryItem: ...
    def query(self, *, scope: dict | None = None, limit: int = 10) -> list[MemoryItem]: ...


class InMemoryStore:
    """A simple, dependency-free store for tests and dry-runs."""

    def __init__(self) -> None:
        self._items: list[MemoryItem] = []

    def write_candidate(self, item: MemoryItem) -> MemoryItem:
        reasons = validate_memory_candidate(item, self._items)
        if reasons:
            raise MemoryRejected("; ".join(reasons))
        self._items.append(item)
        return item

    def query(self, *, scope: dict | None = None, limit: int = 10) -> list[MemoryItem]:
        items = self._items
        if scope:
            items = [
                m for m in items
                if all(m.scope.get(k) == v for k, v in scope.items())
            ]
        # Highest-confidence first.
        return sorted(items, key=lambda m: m.confidence, reverse=True)[:limit]

    def all(self) -> list[MemoryItem]:
        return list(self._items)
