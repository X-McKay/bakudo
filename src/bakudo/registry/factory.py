"""Ledger construction from the environment (P2 Task 2).

The CLI (and anything else that wants "durable if configured, in-memory
otherwise" without hand-wiring Postgres) calls :func:`ledger_from_env` instead
of constructing :class:`~bakudo.registry.ledger.InMemoryLedger` directly.
Mirrors the DSN convention ``temporal.worker._wire_dependencies`` already
uses for the durable memory store.
"""

from __future__ import annotations

import os

from .ledger import InMemoryLedger, Ledger

_DSN_VAR = "BAKUDO_POSTGRES_DSN"


def ledger_from_env() -> Ledger:
    """Return a :class:`PostgresLedger` bound to ``BAKUDO_POSTGRES_DSN`` when
    that env var is set, else a fresh :class:`InMemoryLedger`.

    ``psycopg`` is only ever imported inside this DSN branch (and, for the
    actual connection, lazily again inside ``PostgresLedger``) so every other
    bakudo entrypoint keeps importing without the ``db`` extra installed. If
    the DSN is set but ``psycopg`` isn't importable, that's a misconfigured
    deployment -- fail loudly with an actionable message rather than
    silently falling back to (or crashing later inside) the in-memory ledger.
    """
    dsn = os.environ.get(_DSN_VAR)
    if not dsn:
        return InMemoryLedger()

    try:
        import psycopg  # noqa: F401 -- presence check only; PostgresLedger imports it itself
    except ImportError as exc:
        raise RuntimeError(
            f"{_DSN_VAR} is set but psycopg is not installed; install the "
            "`db` extra (`pip install 'bakudo[db]'`) or unset "
            f"{_DSN_VAR} to fall back to the in-memory ledger."
        ) from exc

    from .postgres_ledger import PostgresLedger

    return PostgresLedger(dsn=dsn)
