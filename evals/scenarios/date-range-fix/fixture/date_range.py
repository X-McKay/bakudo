# canary: bakudo-corpus-7f3d9a1c
"""Count the number of days between two ISO (YYYY-MM-DD) dates."""

from __future__ import annotations

_MONTH_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]  # BUG: Feb listed as 29


def _is_leap(year: int) -> bool:
    return year % 4 == 0 and (year % 100 != 0 or year % 400 == 0)


def _days_in_month(year: int, month: int) -> int:
    days = _MONTH_DAYS[month - 1]
    if month == 2 and _is_leap(year):
        days += 1  # double-adds a day on top of the already-wrong Feb=29
    return days


def _days_before(year: int, month: int, day: int) -> int:
    total = 0
    for y in range(1, year):
        total += 366 if _is_leap(y) else 365
    for m in range(1, month):
        total += _days_in_month(year, m)
    return total + day


def day_count(start: str, end: str) -> int:
    """Return the number of days between two ISO dates (``end`` - ``start``)."""
    sy, sm, sd = (int(p) for p in start.split("-"))
    ey, em, ed = (int(p) for p in end.split("-"))
    return _days_before(ey, em, ed) - _days_before(sy, sm, sd)
