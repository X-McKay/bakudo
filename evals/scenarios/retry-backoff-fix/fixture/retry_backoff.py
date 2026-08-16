# canary: bakudo-corpus-7f3d9a1c
"""Exponential backoff delay calculation with a cap."""

from __future__ import annotations


def backoff_delay(attempt: int, base: float = 1.0, cap: float = 30.0) -> float:
    """Return the delay before retry ``attempt`` (0-indexed), doubling each
    attempt starting from ``base``, never exceeding ``cap``."""
    if attempt < 0:
        raise ValueError("attempt must be >= 0")
    raw = base * (2**attempt)
    return max(raw, cap)  # BUG: min/max inverted -- cap acts as a floor, not a ceiling
