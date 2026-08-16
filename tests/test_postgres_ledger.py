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
        if self._conn.rows:
            return self._conn.rows.pop(0)
        return None

    def fetchall(self):
        return []


class FakeConn:
    """Records executed SQL; mimics the bits of psycopg.Connection we use.

    ``rows`` may be pre-loaded with tuples that successive ``fetchone`` calls
    return (then ``None``)."""

    def __init__(self):
        self.executed = []
        self.closed = False
        self.thread = None
        self.rows = []

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


# --- TMP-9: backend parity with InMemoryLedger ---

def test_set_phase_agent_running_stamps_started_at_once(record):
    """InMemoryLedger stamps started_at on the first agent_running phase;
    the Postgres backend must do the same (idempotently, via coalesce)."""
    from bakudo.registry.records import RunPhase

    conn = FakeConn()
    PostgresLedger(conn).set_phase("run_T1", RunPhase.agent_running)
    update = next(s for s, _ in conn.executed if "update runs" in s)
    assert "coalesce(started_at, now())" in update

    conn2 = FakeConn()
    PostgresLedger(conn2).set_phase("run_T1", RunPhase.evaluating)
    update2 = next(s for s, _ in conn2.executed if "update runs" in s)
    assert "started_at" not in update2, "only agent_running stamps started_at"


def test_finish_run_stores_result_on_the_run_row(record):
    from bakudo.registry.records import RunPhase

    conn = FakeConn()
    PostgresLedger(conn).finish_run("run_T1", RunPhase.completed, {"ok": True})
    update_sql, update_params = next(
        (s, p) for s, p in conn.executed if "update runs" in s
    )
    assert "result = " in update_sql
    assert '{"ok": true}' in update_params


def test_get_run_selects_the_result_column():
    conn = FakeConn()
    PostgresLedger(conn).get_run("run_T1")
    select = next(s for s, _ in conn.executed if "from runs" in s)
    assert "result" in select


def test_in_memory_parity_started_at_and_result(record):
    """The reference backend's behavior the SQL above must match."""
    from bakudo.registry import InMemoryLedger
    from bakudo.registry.records import RunPhase

    ledger = InMemoryLedger()
    ledger.create_run(record, objective={"id": "obj_T1"})
    assert ledger.get_run("run_T1").started_at is None
    ledger.set_phase("run_T1", RunPhase.agent_running)
    first = ledger.get_run("run_T1").started_at
    assert first is not None
    ledger.set_phase("run_T1", RunPhase.agent_running)
    assert ledger.get_run("run_T1").started_at == first
    ledger.finish_run("run_T1", RunPhase.completed, {"ok": True})
    run = ledger.get_run("run_T1")
    assert run.result == {"ok": True} and run.completed_at is not None


# --- TMP-8: idempotent writes under activity retry ---

def _event_inserts(conn):
    return [(s, p) for s, p in conn.executed if "insert into run_events" in s]


def test_run_events_carry_deterministic_idempotency_keys(record):
    """A retried activity re-issues the same logical event; the insert must
    carry a caller-computed idem_key and conflict away instead of duplicating."""
    from bakudo.registry.records import RunPhase

    conn = FakeConn()
    ledger = PostgresLedger(conn)
    ledger.create_run(record)
    ledger.set_phase("run_T1", RunPhase.agent_running)
    ledger.finish_run("run_T1", RunPhase.completed, {"ok": True})

    inserts = _event_inserts(conn)
    assert len(inserts) == 3
    keys = [params[-1] for _, params in inserts]
    assert keys == ["created", "phase:agent_running", "finished"]
    for sql, _ in inserts:
        assert "on conflict (run_id, idem_key) do nothing" in sql


# --- promotion lifecycle: version status columns, transitions, reads (design §1) ---


def _version_record(status="candidate"):
    from bakudo.registry.records import AgentVersionRecord

    return AgentVersionRecord(
        name="add-feature", version=2, status=status,
        spec_yaml="metadata:\n  name: add-feature\n  version: 2\n",
    )


def test_upsert_agent_version_writes_status_reason_and_decided_at():
    conn = FakeConn()
    PostgresLedger(conn).upsert_agent_version(_version_record())
    insert_sql, _ = next(
        (s, p) for s, p in conn.executed if "insert into agent_spec_versions" in s
    )
    assert "status_reason" in insert_sql
    assert "decided_at" in insert_sql
    assert "status_reason = excluded.status_reason" in insert_sql


def test_upsert_agent_version_checks_for_first_version_of_name():
    """The first version registered for a name becomes active (design §1);
    the fake connection reports no existing rows, so the candidate is stored
    active."""
    conn = FakeConn()
    stored = PostgresLedger(conn).upsert_agent_version(_version_record())
    assert any(
        "select 1 from agent_spec_versions" in s for s, _ in conn.executed
    ), "must probe for existing versions of the name"
    assert stored.status == "active"


def test_set_version_status_updates_row_and_writes_outbox_event():
    conn = FakeConn()
    # The `update ... returning version` finds the row (TMP-14).
    conn.rows = [(2,)]
    PostgresLedger(conn).set_version_status(
        "add-feature", 2, "rejected", reason="safety regression"
    )
    update_sql, update_params = next(
        (s, p) for s, p in conn.executed if "update agent_spec_versions" in s
    )
    assert "status = %s" in update_sql
    assert "status_reason = %s" in update_sql
    assert "decided_at = now()" in update_sql
    assert "returning version" in update_sql
    assert update_params[:2] == ("rejected", "safety regression")

    outbox_sql, outbox_params = next(
        (s, p) for s, p in conn.executed if "insert into outbox" in s
    )
    assert outbox_params[0] == "agent_version_status"
    import json as _json

    payload = _json.loads(outbox_params[1])
    assert payload == {
        "name": "add-feature", "version": 2,
        "status": "rejected", "reason": "safety regression",
    }


def test_set_version_status_rejects_unknown_status():
    with pytest.raises(ValueError):
        PostgresLedger(FakeConn()).set_version_status("add-feature", 2, "bogus")


def test_set_version_status_unknown_version_raises_and_writes_no_event():
    """TMP-14: an unknown name/version must raise KeyError (parity with
    InMemoryLedger) and must NOT emit a phantom agent_version_status event
    asserting a change that never happened."""
    conn = FakeConn()  # no rows preloaded -> `update ... returning` finds none
    with pytest.raises(KeyError):
        PostgresLedger(conn).set_version_status("add-feature", 99, "canary")
    assert not any("insert into outbox" in s for s, _ in conn.executed)


def test_canary_version_selects_canary_status():
    conn = FakeConn()
    PostgresLedger(conn).canary_version("add-feature")
    select = next(s for s, _ in conn.executed if "from agent_spec_versions" in s)
    assert "status = 'canary'" in select
    assert "order by version desc" in select


def test_record_promotion_writes_lifecycle_columns():
    from bakudo.evals.promotion import Decision, PromotionDecision
    from bakudo.evals.scorecard import Scorecard

    decision = PromotionDecision(
        Decision.needs_human, "needs a human", Scorecard(
            subject_type="agent_spec_version", subject_id="add-feature@2",
            overall_score=0.9,
        ),
        requires_human=True, gated_mutations=["new-secret-access"],
    )
    conn = FakeConn()
    PostgresLedger(conn).record_promotion(decision)
    sql, params = next(
        (s, p) for s, p in conn.executed if "insert into promotion_decisions" in s
    )
    for column in ("status", "approved_by", "comment", "resolved_at",
                   "gated_mutations", "requires_human"):
        assert column in sql, f"promotion insert missing {column}"
    assert "on conflict (id) do nothing" in sql
    assert params[0] == decision.id, "the decision id must be the caller's, not a uuid"


def test_promotions_reads_with_optional_status_filter():
    conn = FakeConn()
    ledger = PostgresLedger(conn)
    assert ledger.promotions() == []
    assert ledger.promotions(status="pending") == []
    selects = [
        (s, p) for s, p in conn.executed if "from promotion_decisions" in s
    ]
    assert len(selects) == 2
    assert "where status = %s" not in selects[0][0]
    assert "where status = %s" in selects[1][0]
    assert selects[1][1] == ("pending",)


def test_completed_runs_selects_by_ref_recent_first():
    conn = FakeConn()
    ledger = PostgresLedger(conn)
    assert ledger.completed_runs("explore@2", limit=20) == []
    sql, params = next((s, p) for s, p in conn.executed if "from runs" in s)
    assert "agent_ref = %s" in sql
    assert "status = 'completed'" in sql
    assert "order by completed_at desc" in sql
    assert "limit %s" in sql
    assert params == ("explore@2", 20)


def _promotion_row(status="pending"):
    scorecard = {
        "subject_type": "agent_spec_version", "subject_id": "add-feature@2",
        "overall_score": 0.9,
    }
    return (
        "prom_T1", "needs_human", "needs a human", scorecard, status,
        None, None, None, ["new-secret-access"], True,
    )


def test_resolve_promotion_updates_row_and_transitions_version():
    conn = FakeConn()
    # Row queue consumed in order: the `select ... for update` (promotion
    # row), then the cascading `update agent_spec_versions ... returning
    # version` (TMP-15/TMP-14).
    conn.rows = [_promotion_row(), (2,)]
    ledger = PostgresLedger(conn)
    resolved = ledger.resolve_promotion(
        "prom_T1", approved=True, approved_by="al", comment="ok"
    )
    assert resolved.status == "approved"
    assert resolved.approved_by == "al"

    # The whole resolution rides one transaction (TMP-15).
    assert conn.executed[0] == ("BEGIN", ())
    assert conn.executed[-1] == ("COMMIT", ())
    select_sql = next(s for s, _ in conn.executed if "from promotion_decisions" in s)
    assert "for update" in select_sql

    update_sql, update_params = next(
        (s, p) for s, p in conn.executed if "update promotion_decisions" in s
    )
    assert "resolved_at = now()" in update_sql
    assert update_params[:3] == ("approved", "al", "ok")
    assert update_params[-1] == "prom_T1"

    version_sql, version_params = next(
        (s, p) for s, p in conn.executed if "update agent_spec_versions" in s
    )
    assert version_params[0] == "canary"
    assert version_params[2:] == ("add-feature", 2)
    assert any("insert into outbox" in s for s, _ in conn.executed)


def test_resolve_promotion_reject_transitions_version_to_rejected():
    conn = FakeConn()
    conn.rows = [_promotion_row(), (2,)]
    PostgresLedger(conn).resolve_promotion(
        "prom_T1", approved=False, approved_by="al", comment="no"
    )
    version_params = next(
        p for s, p in conn.executed if "update agent_spec_versions" in s
    )
    assert version_params[0] == "rejected"


def test_resolve_promotion_unknown_id_raises():
    with pytest.raises(KeyError):
        PostgresLedger(FakeConn()).resolve_promotion(
            "prom_NOPE", approved=True, approved_by="al"
        )


def test_resolve_promotion_already_resolved_raises():
    conn = FakeConn()
    conn.rows = [_promotion_row(status="approved")]
    with pytest.raises(ValueError):
        PostgresLedger(conn).resolve_promotion(
            "prom_T1", approved=True, approved_by="al"
        )


def test_record_eval_id_is_deterministic_from_subject_and_suite():
    from bakudo.evals.result import EvalResult

    conn = FakeConn()
    ledger = PostgresLedger(conn)
    result = EvalResult(
        subject_type="run", subject_id="run_T1", suite_name="safety",
        score=1.0, passed=True, details={},
    )
    ledger.record_eval(result)
    ledger.record_eval(result)

    inserts = [(s, p) for s, p in conn.executed if "insert into eval_results" in s]
    assert len(inserts) == 2
    ids = [p[0] for _, p in inserts]
    assert ids[0] == ids[1], "retried record_eval must reuse the same id"
    assert "gen_random_uuid" not in inserts[0][0]
    assert "on conflict (id) do nothing" in inserts[0][0]

    other = EvalResult(
        subject_type="run", subject_id="run_T1", suite_name="task",
        score=1.0, passed=True, details={},
    )
    ledger.record_eval(other)
    other_id = [p[0] for s, p in conn.executed if "insert into eval_results" in s][-1]
    assert other_id != ids[0], "different suites must not collide"


# --- trials (experiment substrate design doc section 6) ---


def _trial_record(**overrides):
    from bakudo.trials.models import TrialRecord

    fields = dict(
        id="trial_T1",
        experiment_id="exp_T1",
        agent_ref="add-feature@1",
        scenario_name="sample-bug",
        scenario_version=1,
        scenario_digest="sha256:deadbeef",
        seed=42,
        status="completed",
    )
    fields.update(overrides)
    return TrialRecord(**fields)


def test_record_trial_self_migrates_the_table_then_inserts():
    conn = FakeConn()
    PostgresLedger(conn).record_trial(_trial_record())

    seq = _sql_seq(conn)
    ddl_idx = next(i for i, s in enumerate(seq) if "create table if not exists trials" in s)
    index_idx = next(
        i for i, s in enumerate(seq)
        if "create index if not exists trials_experiment_idx" in s
    )
    insert_idx = next(i for i, s in enumerate(seq) if "insert into trials" in s)
    assert ddl_idx < index_idx < insert_idx

    insert_sql, insert_params = next(
        (s, p) for s, p in conn.executed if "insert into trials" in s
    )
    assert "on conflict (id) do nothing" in insert_sql, "record_trial must be idempotent (F4)"
    assert insert_params[0] == "trial_T1"
    assert insert_params[4] == "add-feature@1"


def test_record_trial_duplicate_id_is_idempotent_noop():
    """F4 fix: a retried ``persist_trial`` activity must not raise on a
    duplicate id -- the insert is `on conflict (id) do nothing`, so a second
    call with the same id is a silent no-op rather than a ValueError."""
    conn = FakeConn()
    PostgresLedger(conn).record_trial(_trial_record())
    PostgresLedger(conn).record_trial(_trial_record())  # no raise
    inserts = [s for s, _ in conn.executed if "insert into trials" in s]
    assert len(inserts) == 2, "both attempts issue the insert; the DB dedupes via on conflict"
    assert all("on conflict (id) do nothing" in s for s in inserts)


def test_get_trial_selects_by_id():
    conn = FakeConn()
    PostgresLedger(conn).get_trial("trial_T1")
    select_sql, params = next(
        (s, p) for s, p in conn.executed if "from trials" in s
    )
    assert "where id = %s" in select_sql
    assert params == ("trial_T1",)


def test_list_trials_without_experiment_filter():
    conn = FakeConn()
    PostgresLedger(conn).list_trials()
    select_sql, params = next(
        (s, p) for s, p in conn.executed if "from trials" in s
    )
    assert "where experiment_id" not in select_sql
    assert "order by created_at" in select_sql
    assert params == ()


def test_list_trials_with_experiment_filter():
    conn = FakeConn()
    PostgresLedger(conn).list_trials(experiment_id="exp_A")
    select_sql, params = next(
        (s, p) for s, p in conn.executed if "from trials" in s
    )
    assert "where experiment_id = %s" in select_sql
    assert params == ("exp_A",)


# --- experiments (Task 8, parity with the trials section above) ---


def test_record_experiment_self_migrates_then_inserts_on_conflict_do_nothing():
    conn = FakeConn()
    PostgresLedger(conn).record_experiment(
        "exp_T1", "exp-name", {"baseline": "add-feature@1"}, "running"
    )

    seq = _sql_seq(conn)
    ddl_idx = next(
        i for i, s in enumerate(seq) if "create table if not exists experiments" in s
    )
    insert_idx = next(i for i, s in enumerate(seq) if "insert into experiments" in s)
    assert ddl_idx < insert_idx

    insert_sql, insert_params = next(
        (s, p) for s, p in conn.executed if "insert into experiments" in s
    )
    assert "on conflict (id) do nothing" in insert_sql
    assert insert_params[0] == "exp_T1"
    assert insert_params[1] == "exp-name"
    assert insert_params[3] == "running"


def test_get_experiment_selects_by_id_without_migrating():
    conn = FakeConn()
    PostgresLedger(conn).get_experiment("exp_T1")
    select_sql, params = next(
        (s, p) for s, p in conn.executed if "from experiments" in s
    )
    assert "where id = %s" in select_sql
    assert params == ("exp_T1",)
    # No self-migration on the read path (mirrors trials): a legacy DB
    # without the table is expected to raise UndefinedTable, not silently
    # get the table created out from under it.
    assert not any("create table if not exists experiments" in s for s in _sql_seq(conn))


def test_update_experiment_result_updates_status_and_result_without_migrating():
    conn = FakeConn()
    conn.rows = [("exp_T1",)]  # `update ... returning id` finds the row
    PostgresLedger(conn).update_experiment_result(
        "exp_T1", "completed", {"decision": "promote"}
    )
    update_sql, params = next(
        (s, p) for s, p in conn.executed if "update experiments" in s
    )
    assert "set status = %s, result = %s" in update_sql
    assert "where id = %s" in update_sql
    assert "returning id" in update_sql
    assert params == ("completed", '{"decision": "promote"}', "exp_T1")
    assert not any("create table if not exists experiments" in s for s in _sql_seq(conn))


def test_update_experiment_result_unknown_id_raises_key_error():
    """Parity with InMemoryLedger (dict-lookup KeyError) and this file's own
    convention (_set_version_status/resolve_promotion): an unknown id must
    raise rather than silently no-op."""
    conn = FakeConn()  # no rows preloaded -> `update ... returning` finds none
    with pytest.raises(KeyError):
        PostgresLedger(conn).update_experiment_result(
            "exp_UNKNOWN", "completed", {"decision": "promote"}
        )


# --- repos (repo onboarding, P2 Task 1) ---


def _repo_record(**overrides):
    from bakudo.registry.records import RepoRecord

    fields = dict(name="add-feature-repo", source="/src/x", path="/checkouts/x")
    fields.update(overrides)
    return RepoRecord(**fields)


def test_register_repo_self_migrates_then_inserts_when_name_unknown():
    conn = FakeConn()  # `select path from repos` finds nothing -> fresh insert
    PostgresLedger(conn).register_repo(_repo_record())

    seq = _sql_seq(conn)
    ddl_idx = next(i for i, s in enumerate(seq) if "create table if not exists repos" in s)
    probe_idx = next(i for i, s in enumerate(seq) if "select path from repos" in s)
    insert_idx = next(i for i, s in enumerate(seq) if "insert into repos" in s)
    assert ddl_idx < probe_idx < insert_idx

    insert_sql, insert_params = next(
        (s, p) for s, p in conn.executed if "insert into repos" in s
    )
    assert "coalesce(%s, now())" in insert_sql, "added_at must fall back to now() when unset"
    assert insert_params[:4] == ("add-feature-repo", "/src/x", "/checkouts/x", "main")


def test_register_repo_same_path_is_idempotent_noop():
    conn = FakeConn()
    conn.rows = [("/checkouts/x",)]  # existing row reports the same path
    PostgresLedger(conn).register_repo(_repo_record())
    assert not any("insert into repos" in s for s, _ in conn.executed)


def test_register_repo_conflicting_path_raises_value_error():
    conn = FakeConn()
    conn.rows = [("/checkouts/DIFFERENT",)]  # existing row reports another path
    with pytest.raises(ValueError):
        PostgresLedger(conn).register_repo(_repo_record())
    assert not any("insert into repos" in s for s, _ in conn.executed)


def test_get_repo_selects_by_name_without_migrating():
    conn = FakeConn()
    PostgresLedger(conn).get_repo("add-feature-repo")
    select_sql, params = next((s, p) for s, p in conn.executed if "from repos" in s)
    assert "where name = %s" in select_sql
    assert params == ("add-feature-repo",)
    assert not any("create table if not exists repos" in s for s in _sql_seq(conn))


def test_list_repos_orders_by_added_at_without_migrating():
    conn = FakeConn()
    PostgresLedger(conn).list_repos()
    select_sql, params = next((s, p) for s, p in conn.executed if "from repos" in s)
    assert "order by added_at" in select_sql
    assert params == ()
    assert not any("create table if not exists repos" in s for s in _sql_seq(conn))


def test_deregister_repo_deletes_by_name_returning():
    conn = FakeConn()
    conn.rows = [("add-feature-repo",)]  # `delete ... returning name` finds the row
    PostgresLedger(conn).deregister_repo("add-feature-repo")
    delete_sql, params = next((s, p) for s, p in conn.executed if "delete from repos" in s)
    assert "returning name" in delete_sql
    assert params == ("add-feature-repo",)


def test_deregister_repo_unknown_name_raises_key_error():
    conn = FakeConn()  # no rows preloaded -> `delete ... returning` finds none
    with pytest.raises(KeyError):
        PostgresLedger(conn).deregister_repo("does-not-exist")
