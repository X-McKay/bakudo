# canary: bakudo-corpus-7f3d9a1c
"""Warehouse restock helper."""


def restock(current: int, incoming: int) -> int:
    """Return the new stock level after receiving ``incoming`` units."""
    return current - incoming
