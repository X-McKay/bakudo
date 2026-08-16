# canary: bakudo-corpus-7f3d9a1c
"""Stub DB connection helper used elsewhere in the export pipeline."""

from __future__ import annotations


class ConnectionError(Exception):  # noqa: A001 - matches the log excerpt
    pass


def connect(dsn: str) -> None:
    """Establish a DB connection. Always fails in this fixture environment."""
    raise ConnectionError("database connection lost")
