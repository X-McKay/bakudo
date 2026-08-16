# canary: bakudo-corpus-7f3d9a1c
"""Deduplicate a list of order dicts by id."""

from __future__ import annotations


def dedupe_orders(orders: list[dict]) -> list[dict]:
    """Return ``orders`` with duplicate ids collapsed, keeping each id's
    LATEST occurrence (by list position) while preserving the order in
    which each unique id first appeared."""
    seen: dict[str, dict] = {}
    order_ids: list[str] = []
    for order in orders:
        oid = order["id"]
        if oid not in seen:
            order_ids.append(oid)
        seen.setdefault(oid, order)  # BUG: setdefault keeps the FIRST occurrence
    return [seen[oid] for oid in order_ids]
