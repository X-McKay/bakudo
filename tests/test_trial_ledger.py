"""Trial model + ledger parity tests (Task 6).

Runs against :class:`InMemoryLedger` unconditionally. The Postgres backend's
SQL shape is covered by ``FakeConn`` tests in ``test_postgres_ledger.py``,
and a full round-trip against a real database lives in
``test_postgres_ledger_live.py`` (``BAKUDO_POSTGRES_DSN``-gated, following
that file's existing live-DB skip pattern).
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from bakudo.ids import new_trial_id
from bakudo.registry import InMemoryLedger
from bakudo.trials.models import HackFlags, TrialRecord


def make_trial(*, id: str, experiment_id: str | None = None, **overrides) -> TrialRecord:
    fields: dict = dict(
        id=id,
        experiment_id=experiment_id,
        agent_ref="add-feature@1",
        scenario_name="sample-bug",
        scenario_version=1,
        scenario_digest="sha256:deadbeef",
        seed=42,
        status="completed",
    )
    fields.update(overrides)
    return TrialRecord(**fields)


@pytest.fixture
def ledger() -> InMemoryLedger:
    return InMemoryLedger()


def test_trial_roundtrip(ledger):
    t = make_trial(id=new_trial_id(), experiment_id="exp_X")
    ledger.record_trial(t)
    assert ledger.get_trial(t.id) == t


def test_get_trial_unknown_returns_none(ledger):
    assert ledger.get_trial("trial_UNKNOWN") is None


def test_record_trial_duplicate_id_is_idempotent_noop(ledger):
    """F4 fix: a retried ``persist_trial`` activity (Temporal
    at-least-once) must not raise on a duplicate id -- the second write is a
    silent no-op, matching ``record_experiment``'s "on conflict do nothing"
    convention, and exactly one row is stored."""
    t = make_trial(id=new_trial_id())
    ledger.record_trial(t)
    ledger.record_trial(t)  # no raise
    assert ledger.get_trial(t.id) == t
    assert len(ledger.list_trials()) == 1


def test_list_by_experiment(ledger):
    a1 = make_trial(id=new_trial_id(), experiment_id="exp_A")
    a2 = make_trial(id=new_trial_id(), experiment_id="exp_A")
    b1 = make_trial(id=new_trial_id(), experiment_id="exp_B")
    for t in (a1, a2, b1):
        ledger.record_trial(t)

    exp_a = ledger.list_trials(experiment_id="exp_A")
    assert {t.id for t in exp_a} == {a1.id, a2.id}

    everything = ledger.list_trials()
    assert {t.id for t in everything} == {a1.id, a2.id, b1.id}


def test_list_trials_empty_when_no_match(ledger):
    ledger.record_trial(make_trial(id=new_trial_id(), experiment_id="exp_A"))
    assert ledger.list_trials(experiment_id="exp_NONE") == []


def test_trial_record_defaults():
    t = make_trial(id=new_trial_id())
    assert t.flags == HackFlags()
    assert t.pins == {}
    assert t.metrics == {}
    assert t.evaluation == {}
    assert t.run_id is None
    assert t.objective_id is None
    assert t.experiment_id is None


def test_trial_record_rejects_unknown_fields():
    with pytest.raises(ValidationError):
        TrialRecord(
            id=new_trial_id(),
            agent_ref="add-feature@1",
            scenario_name="sample-bug",
            scenario_version=1,
            scenario_digest="sha256:deadbeef",
            seed=42,
            status="completed",
            bogus_field="nope",
        )


def test_hack_flags_rejects_unknown_fields():
    with pytest.raises(ValidationError):
        HackFlags(bogus=True)


# --- experiments (Task 8 parity with the trial methods above) ---


def test_experiment_roundtrip(ledger):
    eid = "exp_ROUNDTRIP"
    spec = {"metadata": {"name": "exp-roundtrip"}, "baseline": "add-feature@1"}
    ledger.record_experiment(eid, "exp-roundtrip", spec, "running")

    got = ledger.get_experiment(eid)
    assert got["id"] == eid
    assert got["name"] == "exp-roundtrip"
    assert got["spec"] == spec
    assert got["status"] == "running"
    assert got["result"] is None

    ledger.update_experiment_result(eid, "completed", {"decision": "promote"})
    got = ledger.get_experiment(eid)
    assert got["status"] == "completed"
    assert got["result"] == {"decision": "promote"}


def test_get_experiment_unknown_returns_none(ledger):
    assert ledger.get_experiment("exp_UNKNOWN") is None


def test_record_experiment_is_idempotent(ledger):
    eid = "exp_IDEMPOTENT"
    ledger.record_experiment(eid, "first", {"a": 1}, "running")
    ledger.update_experiment_result(eid, "completed", {"decision": "promote"})

    # A retried record call must not clobber the progress already made.
    ledger.record_experiment(eid, "second", {"a": 2}, "running")
    got = ledger.get_experiment(eid)
    assert got["name"] == "first"
    assert got["status"] == "completed"
    assert got["result"] == {"decision": "promote"}


def test_update_experiment_result_unknown_raises(ledger):
    with pytest.raises(KeyError):
        ledger.update_experiment_result("exp_UNKNOWN", "completed", {})
