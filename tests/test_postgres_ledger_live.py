"""Live PostgresLedger round-trip (TMP-2).

Marked ``live``: runs only when ``BAKUDO_POSTGRES_DSN`` is explicitly set.
Normal test runs never connect to anything. All rows use throwaway
``run_E2E``/``obj_E2E`` identifiers and are deleted afterwards.
"""

from __future__ import annotations

import os

import pytest

from bakudo.registry.postgres_ledger import _REPOS_DDL, PostgresLedger
from bakudo.registry.records import RunPhase, RunRecord

DSN = os.environ.get("BAKUDO_POSTGRES_DSN")

pytestmark = [
    pytest.mark.live,
    pytest.mark.skipif(not DSN, reason="BAKUDO_POSTGRES_DSN not set"),
]

RUN_ID = "run_E2ELEDGER1"
OBJ_ID = "obj_E2ELEDGER1"
TRIAL_A1_ID = "trial_E2ELEDGERA1"
TRIAL_A2_ID = "trial_E2ELEDGERA2"
TRIAL_B1_ID = "trial_E2ELEDGERB1"
EXPERIMENT_ID = "exp_E2ELEDGER1"
REPO_NAME = "repo_E2ELEDGER1"


@pytest.fixture
def ledger():
    lg = PostgresLedger.connect(DSN)
    _cleanup(lg)
    yield lg
    _cleanup(lg)


def _cleanup(lg: PostgresLedger) -> None:
    with lg._connection() as conn, conn.cursor() as cur:
        cur.execute("delete from eval_results where subject_id = %s", (RUN_ID,))
        cur.execute("delete from run_events where run_id = %s", (RUN_ID,))
        cur.execute("delete from runs where id = %s", (RUN_ID,))
        cur.execute("delete from objectives where id = %s", (OBJ_ID,))
        cur.execute(
            "delete from trials where id = any(%s)",
            ([TRIAL_A1_ID, TRIAL_A2_ID, TRIAL_B1_ID],),
        )
        cur.execute("delete from experiments where id = %s", (EXPERIMENT_ID,))
        # repos may not exist yet on a DB that predates this table (its DDL
        # self-migrates lazily in register_repo, never on a bare delete).
        cur.execute(_REPOS_DDL)
        cur.execute("delete from repos where name = %s", (REPO_NAME,))


def _record() -> RunRecord:
    return RunRecord(
        id=RUN_ID,
        temporal_workflow_id=f"e2e-{RUN_ID}",
        abox_task_id=RUN_ID,
        objective_id=OBJ_ID,
        agent_ref="explore@1",
        git_branch=f"agent/{RUN_ID}",
    )


def _objective() -> dict:
    return {
        "id": OBJ_ID,
        "repo": "e2e-validate",
        "type": "explore",
        "title": "live ledger round-trip",
        "priority": {"score": 0.4},
        "status": "ready",
    }


def test_create_phase_finish_events_round_trip(ledger):
    # create (with objective upsert — the FK that killed every first run, TMP-2)
    ledger.create_run(_record(), objective=_objective())
    run = ledger.get_run(RUN_ID)
    assert run is not None and run.phase == RunPhase.created

    # objective row exists and is idempotently re-upsertable
    ledger.create_run(_record(), objective=_objective())

    # phase advance
    ledger.set_phase(RUN_ID, RunPhase.agent_running)
    run = ledger.get_run(RUN_ID)
    assert run.phase == RunPhase.agent_running
    assert run.started_at is not None, "agent_running must stamp started_at (TMP-9)"

    # finish
    ledger.finish_run(RUN_ID, RunPhase.completed, {"status": "success"})
    run = ledger.get_run(RUN_ID)
    assert run.phase == RunPhase.completed
    assert run.completed_at is not None
    assert run.result == {"status": "success"}, "finish_run must store result (TMP-9)"

    # event log round-trip
    events = ledger.events(RUN_ID)
    kinds = [e.event_type for e in events]
    assert kinds.count("created") == 1, "created event must be idempotent (TMP-8)"
    assert "phase" in kinds and kinds.count("finished") == 1

    # retried phase/finish writes must not duplicate events (TMP-8)
    ledger.set_phase(RUN_ID, RunPhase.agent_running)
    ledger.finish_run(RUN_ID, RunPhase.completed, {"status": "success"})
    kinds = [e.event_type for e in ledger.events(RUN_ID)]
    assert kinds.count("finished") == 1
    assert sum(1 for e in ledger.events(RUN_ID) if e.idem_key == "phase:agent_running") == 1


def test_record_eval_retry_is_idempotent(ledger):
    from bakudo.evals.result import EvalResult

    ledger.create_run(_record(), objective=_objective())
    result = EvalResult(
        subject_type="run",
        subject_id=RUN_ID,
        suite_name="safety",
        score=1.0,
        passed=True,
        details={"note": "live idempotency probe"},
    )
    ledger.record_eval(result)
    ledger.record_eval(result)  # simulated activity retry
    rows = ledger.eval_results(RUN_ID)
    assert len(rows) == 1, "retried record_eval must not duplicate rows (TMP-8)"


# --- trials (Task 6, experiment substrate design doc section 6) ---


def _trial(trial_id: str, experiment_id: str):
    from bakudo.ids import new_episode_id
    from bakudo.tasks.models import TaskPin
    from bakudo.trials.models import IntegrityFlags, TrialRecord

    return TrialRecord(
        id=trial_id,
        episode_id=new_episode_id(),
        experiment_id=experiment_id,
        run_id=RUN_ID,
        objective_id=OBJ_ID,
        agent_ref="explore@1",
        task=TaskPin(
            source_uri="file:///benchmark-corpus",
            corpus_revision="test-revision",
            name="sample-bug",
            version=1,
            bundle_digest="sha256:deadbeef",
            verifier_digest="sha256:feedface",
        ),
        seed=7,
        runtime_pins={"bakudo": "0.1.0"},
        metrics={"tokens": 1234.0, "duration_s": 12.5},
        evaluation={"f2p_rate": 1.0},
        integrity=IntegrityFlags(),
        status="completed",
        started_at="2026-08-15T00:00:00+00:00",
        completed_at="2026-08-15T00:01:00+00:00",
    )


def test_trial_roundtrip_insert_only_and_list_by_experiment(ledger):
    a1 = _trial(TRIAL_A1_ID, "exp_E2ELEDGER_A")
    a2 = _trial(TRIAL_A2_ID, "exp_E2ELEDGER_A")
    b1 = _trial(TRIAL_B1_ID, "exp_E2ELEDGER_B")

    ledger.record_trial(a1)
    fetched = ledger.get_trial(TRIAL_A1_ID)
    assert fetched == a1, "round trip must reproduce the recorded trial exactly"

    ledger.record_trial(a1)  # F4: duplicate id is an idempotent no-op, not a raise
    assert ledger.get_trial(TRIAL_A1_ID) == a1
    assert len([t for t in ledger.list_trials() if t.id == TRIAL_A1_ID]) == 1

    ledger.record_trial(a2)
    ledger.record_trial(b1)

    exp_a = ledger.list_trials(experiment_id="exp_E2ELEDGER_A")
    assert {t.id for t in exp_a} == {TRIAL_A1_ID, TRIAL_A2_ID}

    exp_b = ledger.list_trials(experiment_id="exp_E2ELEDGER_B")
    assert {t.id for t in exp_b} == {TRIAL_B1_ID}


# --- experiments (Task 8, experiment substrate design doc section 7) ---


def test_experiment_roundtrip_and_unknown_id_raises(ledger):
    spec = {"metadata": {"name": "e2e-experiment"}, "baseline": "explore@1"}
    ledger.record_experiment(EXPERIMENT_ID, "e2e-experiment", "agent-spec", spec, "running")
    got = ledger.get_experiment(EXPERIMENT_ID)
    assert got is not None
    assert got["id"] == EXPERIMENT_ID
    assert got["name"] == "e2e-experiment"
    assert got["subject_kind"] == "agent-spec"
    assert got["spec"] == spec
    assert got["status"] == "running"
    assert got["result"] is None

    # retried record_experiment must not clobber (on conflict do nothing)
    ledger.record_experiment(EXPERIMENT_ID, "different-name", "software-artifact", {}, "running")
    assert ledger.get_experiment(EXPERIMENT_ID)["name"] == "e2e-experiment"

    ledger.update_experiment_result(EXPERIMENT_ID, "completed", {"decision": "promote"})
    got = ledger.get_experiment(EXPERIMENT_ID)
    assert got["status"] == "completed"
    assert got["result"] == {"decision": "promote"}

    assert ledger.get_experiment("exp_E2ELEDGER_UNKNOWN") is None
    with pytest.raises(KeyError):
        ledger.update_experiment_result("exp_E2ELEDGER_UNKNOWN", "completed", {})


# --- repos (repo onboarding, P2 Task 1) ---


def test_repo_roundtrip_idempotent_conflict_and_deregister(ledger):
    from bakudo.registry.records import RepoRecord

    record = RepoRecord(
        name=REPO_NAME, source="https://example.invalid/x.git", path="/checkouts/e2e-x"
    )
    ledger.register_repo(record)
    got = ledger.get_repo(REPO_NAME)
    assert got is not None
    assert got.path == "/checkouts/e2e-x"
    assert got.added_at is not None

    # idempotent: same name+path is a no-op re-register
    ledger.register_repo(record)
    assert len([r for r in ledger.list_repos() if r.name == REPO_NAME]) == 1

    # a conflicting path for the same name raises rather than repointing it
    with pytest.raises(ValueError):
        ledger.register_repo(RepoRecord(name=REPO_NAME, source="other", path="/checkouts/CONFLICT"))
    assert ledger.get_repo(REPO_NAME).path == "/checkouts/e2e-x"

    ledger.deregister_repo(REPO_NAME)
    assert ledger.get_repo(REPO_NAME) is None
    with pytest.raises(KeyError):
        ledger.deregister_repo(REPO_NAME)
