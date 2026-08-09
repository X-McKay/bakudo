"""Live PostgresLedger round-trip (TMP-2).

Marked ``live``: runs only when ``BAKUDO_POSTGRES_DSN`` is explicitly set.
Normal test runs never connect to anything. All rows use throwaway
``run_E2E``/``obj_E2E`` identifiers and are deleted afterwards.
"""

from __future__ import annotations

import os

import pytest

from bakudo.registry.postgres_ledger import PostgresLedger
from bakudo.registry.records import RunPhase, RunRecord

DSN = os.environ.get("BAKUDO_POSTGRES_DSN")

pytestmark = [
    pytest.mark.live,
    pytest.mark.skipif(not DSN, reason="BAKUDO_POSTGRES_DSN not set"),
]

RUN_ID = "run_E2ELEDGER1"
OBJ_ID = "obj_E2ELEDGER1"


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
