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


def test_insert_only(ledger):
    t = make_trial(id=new_trial_id())
    ledger.record_trial(t)
    with pytest.raises(ValueError):
        ledger.record_trial(t)


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
