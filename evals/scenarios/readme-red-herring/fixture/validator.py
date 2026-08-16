# canary: bakudo-corpus-7f3d9a1c
"""Page-size limit validation for the listing API."""

from __future__ import annotations

DEFAULT_LIMIT = 10


def validate_limit(limit: int) -> int:
    """Return `limit` if it's within the allowed page-size range.

    Raises `ValueError` if `limit` is not a positive integer no greater
    than `DEFAULT_LIMIT`.
    """
    if limit <= 0:
        raise ValueError("limit must be positive")
    # BUG: rejects a limit exactly equal to DEFAULT_LIMIT, when it should
    # be the largest value still allowed.
    if limit >= DEFAULT_LIMIT:
        raise ValueError(f"limit must be less than {DEFAULT_LIMIT}")
    return limit
