"""``ledger_from_env`` (P2 Task 2): the CLI's durable-vs-in-memory ledger
switch. ``BAKUDO_POSTGRES_DSN`` unset (or empty) -> InMemoryLedger; set and
psycopg importable -> PostgresLedger bound to that DSN; set but psycopg
missing -> an actionable RuntimeError naming the ``db`` extra, not an
ImportError leaking out of an unrelated module.

Also covers the ``bakudo experiment result`` in-memory-mode warning (CLI
wiring, same task): with no DSN configured that subcommand can only ever see
experiments recorded by its own throwaway ledger, so it prints a one-line
warning saying so.
"""

from __future__ import annotations

import sys

import pytest

from bakudo.registry.ledger import InMemoryLedger
from bakudo.registry.postgres_ledger import PostgresLedger


def test_no_dsn_returns_in_memory_ledger(monkeypatch):
    from bakudo.registry.factory import ledger_from_env

    monkeypatch.delenv("BAKUDO_POSTGRES_DSN", raising=False)

    ledger = ledger_from_env()

    assert isinstance(ledger, InMemoryLedger)


def test_empty_dsn_returns_in_memory_ledger(monkeypatch):
    from bakudo.registry.factory import ledger_from_env

    monkeypatch.setenv("BAKUDO_POSTGRES_DSN", "")

    ledger = ledger_from_env()

    assert isinstance(ledger, InMemoryLedger)


def test_dsn_set_and_psycopg_importable_returns_postgres_ledger(monkeypatch):
    from bakudo.registry.factory import ledger_from_env

    dsn = "postgresql://user:pass@localhost:5432/bakudo"
    monkeypatch.setenv("BAKUDO_POSTGRES_DSN", dsn)

    ledger = ledger_from_env()

    assert isinstance(ledger, PostgresLedger)
    assert ledger._dsn == dsn


def test_dsn_set_but_psycopg_missing_raises_actionable_runtime_error(monkeypatch):
    from bakudo.registry.factory import ledger_from_env

    monkeypatch.setenv("BAKUDO_POSTGRES_DSN", "postgresql://localhost/bakudo")
    # Simulate the `db` extra not being installed: `import psycopg` raises
    # ImportError when a module is set to None in sys.modules (the standard
    # trick for this -- see importlib docs).
    monkeypatch.setitem(sys.modules, "psycopg", None)

    with pytest.raises(RuntimeError, match="db"):
        ledger_from_env()


def test_cli_experiment_result_warns_in_memory_mode(monkeypatch, capsys):
    from bakudo.cli import main

    monkeypatch.delenv("BAKUDO_POSTGRES_DSN", raising=False)

    rc = main(["experiment", "result", "does-not-exist"])

    assert rc == 1
    err = capsys.readouterr().err
    assert "no DSN configured" in err
    assert "not visible" in err
    assert "unknown experiment" in err
