# canary: bakudo-corpus-7f3d9a1c
"""In-memory inventory with reservation."""

from __future__ import annotations


class Inventory:
    def __init__(self, stock: dict[str, int]) -> None:
        self._stock = dict(stock)
        self._snapshot = dict(stock)  # BUG: captured once, never refreshed

    def _available(self, item: str) -> int:
        return self._snapshot.get(item, 0)  # BUG: reads the stale snapshot, not live stock

    def reserve(self, item: str, qty: int = 1) -> bool:
        """Reserve ``qty`` units of ``item``; return False (no state
        change) if insufficient stock remains."""
        if self._available(item) < qty:
            return False
        self._stock[item] -= qty
        return True

    def stock_of(self, item: str) -> int:
        return self._stock.get(item, 0)
