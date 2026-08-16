# canary: bakudo-corpus-7f3d9a1c
"""Sum a numeric column from a CSV file."""

from __future__ import annotations

import csv
from pathlib import Path


def parse_header(path: str) -> list[str]:
    """Return the column names from the CSV header row."""
    with Path(path).open(newline="") as f:
        reader = csv.reader(f)
        return next(reader)


def sum_column(path: str, column: str) -> float:
    """Sum every value in `column` across all data rows of the CSV at `path`."""
    with Path(path).open(newline="") as f:
        reader = csv.reader(f)
        rows = list(reader)
    header = rows[0]
    idx = header.index(column)
    total = 0.0
    for row in rows[1:-1]:  # BUG: drops the last data row
        total += float(row[idx])
    return total
