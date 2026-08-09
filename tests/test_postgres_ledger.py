"""PostgresLedger SQL-shape tests against a fake connection (no live DB).

Covers thread-safety via per-call connections (TMP-1). The live round-trip
against a real Postgres lives in ``test_postgres_ledger_live.py``.
"""

from __future__ import annotations

import threading

import psycopg
import pytest

from bakudo.registry.postgres_ledger import PostgresLedger
from bakudo.registry.records import RunRecord


class FakeCursor:
    def __init__(self, conn):
        self._conn = conn

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=()):
        self._conn.executed.append((" ".join(sql.split()), params))

    def fetchone(self):
        return None

    def fetchall(self):
        return []


class FakeConn:
    """Records executed SQL; mimics the bits of psycopg.Connection we use."""

    def __init__(self):
        self.executed = []
        self.closed = False
        self.thread = None

    def cursor(self):
        self.thread = threading.current_thread().name
        return FakeCursor(self)

    def transaction(self):
        conn = self

        class _Tx:
            def __enter__(self):
                conn.executed.append(("BEGIN", ()))
                return self

            def __exit__(self, *exc):
                conn.executed.append(("COMMIT", ()))
                return False

        return _Tx()

    def close(self):
        self.closed = True


@pytest.fixture
def record():
    return RunRecord(
        id="run_T1",
        temporal_workflow_id="wf-1",
        abox_task_id="run_T1",
        objective_id="obj_T1",
        agent_ref="explore@1",
    )


def test_connect_opens_a_fresh_connection_per_call(monkeypatch, record):
    """TMP-1: one shared psycopg connection is not thread-safe; the DSN mode
    must open (and close) a short-lived connection per ledger call."""
    conns = []

    def fake_connect(dsn, **kwargs):
        assert dsn == "postgresql://fake/db"
        conn = FakeConn()
        conns.append(conn)
        return conn

    monkeypatch.setattr(psycopg, "connect", fake_connect)
    ledger = PostgresLedger.connect("postgresql://fake/db")
    ledger.create_run(record)
    ledger.get_run("run_T1")
    assert len(conns) == 2, "each call must use its own connection"
    assert all(c.closed for c in conns), "per-call connections must be closed"


def test_connect_is_thread_safe_under_concurrent_calls(monkeypatch, record):
    conns = []
    lock = threading.Lock()

    def fake_connect(dsn, **kwargs):
        conn = FakeConn()
        with lock:
            conns.append(conn)
        return conn

    monkeypatch.setattr(psycopg, "connect", fake_connect)
    ledger = PostgresLedger.connect("postgresql://fake/db")

    errors = []

    def call():
        try:
            ledger.get_run("run_T1")
        except Exception as exc:  # pragma: no cover - failure path
            errors.append(exc)

    threads = [threading.Thread(target=call) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert errors == []
    assert len(conns) == 8


def test_injected_connection_still_supported(record):
    """The single-connection constructor stays for tests/tools."""
    conn = FakeConn()
    ledger = PostgresLedger(conn)
    ledger.create_run(record)
    assert any("insert into runs" in sql for sql, _ in conn.executed)
    assert not conn.closed, "injected connections are caller-owned"


# --- TMP-2: create_run upserts the objective row first, same transaction ---

def _sql_seq(conn):
    return [sql for sql, _ in conn.executed]


def test_create_run_upserts_objective_before_run_in_one_transaction(record):
    conn = FakeConn()
    ledger = PostgresLedger(conn)
    objective = {
        "id": "obj_T1", "repo": "bakudo", "type": "explore", "title": "t",
        "priority": {"score": 0.5},
    }
    ledger.create_run(record, objective=objective)

    seq = _sql_seq(conn)
    obj_idx = next(i for i, s in enumerate(seq) if "insert into objectives" in s)
    run_idx = next(i for i, s in enumerate(seq) if "insert into runs" in s)
    begin_idx = seq.index("BEGIN")
    commit_idx = seq.index("COMMIT")
    assert begin_idx < obj_idx < run_idx < commit_idx, (
        "objective upsert must precede the run insert inside one transaction"
    )
    obj_sql, obj_params = next(
        (s, p) for s, p in conn.executed if "insert into objectives" in s
    )
    assert "on conflict (id) do nothing" in obj_sql, "objective upsert must be idempotent"
    assert obj_params[0] == "obj_T1"


def test_create_run_without_objective_upserts_stub_row(record):
    """The runs FK must hold even when the caller has no objective document."""
    conn = FakeConn()
    ledger = PostgresLedger(conn)
    ledger.create_run(record)
    obj_params = next(p for s, p in conn.executed if "insert into objectives" in s)
    assert obj_params[0] == "obj_T1"
