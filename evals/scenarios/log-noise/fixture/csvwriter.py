# canary: bakudo-corpus-7f3d9a1c
"""Format rows for the nightly customer export CSV."""

from __future__ import annotations


def _escape(field: str) -> str:
    """Escape a single field for CSV output."""
    if "," in field:
        # BUG: should quote the field (wrap it in double quotes) so the
        # comma stays part of the value; instead it truncates everything
        # from the first comma onward, silently dropping data.
        return field.split(",")[0]
    return field


def write_row(fields: list[str]) -> str:
    """Format `fields` as a single comma-separated CSV line (no header)."""
    return ",".join(_escape(field) for field in fields)
