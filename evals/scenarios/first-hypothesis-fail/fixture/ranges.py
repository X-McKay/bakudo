# canary: bakudo-corpus-7f3d9a1c
"""Format inclusive integer ranges for display, e.g. "3-7"."""

from __future__ import annotations


def format_range(start: int, end: int) -> str:
    """Format the inclusive range [start, end] as "start-end"."""
    return _join(start, end)


def _join(a: int, b: int) -> str:
    # BUG: subtracts 1 from the high end, so the range comes out
    # exclusive on the right instead of inclusive.
    return f"{a}-{b - 1}"
