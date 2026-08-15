"""Promotion lifecycle: the version status state machine (design 2026-08-09 §1).

Covers the ``AgentVersionRecord`` status vocabulary, the first-version-becomes-
active rule, status transitions with events, and ``Ledger.promotions(status=)``
on the in-memory reference ledger. The Postgres SQL shapes live in
``test_postgres_ledger.py``.
"""

from __future__ import annotations

import pytest

from bakudo.evals.promotion import Decision, PromotionDecision, decide
from bakudo.evals.scorecard import Scorecard
from bakudo.registry import InMemoryLedger
from bakudo.registry.records import VERSION_STATUSES, AgentVersionRecord


def _record(name="add-feature", version=1, status="candidate", **kw):
    return AgentVersionRecord(
        name=name, version=version, status=status,
        spec_yaml=f"metadata:\n  name: {name}\n  version: {version}\n", **kw,
    )


def _card(
    score=0.9, *, subject_id="add-feature@2", cases=30, safety=0, critical=0,
    passed=("schema", "safety", "regression", "role-specific", "code"),
):
    suites = dict.fromkeys(passed, score)
    return Scorecard(
        subject_type="agent_spec_version", subject_id=subject_id,
        overall_score=score, cases_total=cases, suites=suites,
        passed_suites=list(passed), safety_regressions=safety,
        critical_failures=critical,
    )


# --- record shape ---


def test_version_statuses_cover_the_design_state_machine():
    assert set(VERSION_STATUSES) == {
        "candidate", "pending_human", "canary", "active", "rejected", "archived",
    }


def test_agent_version_record_carries_status_reason_and_decided_at():
    record = _record()
    assert record.status_reason is None
    assert record.decided_at is None


def test_agent_version_record_rejects_unknown_status():
    with pytest.raises(ValueError):
        _record(status="promoted")


# --- first version registered for a name becomes active ---


def test_first_version_registered_becomes_active():
    ledger = InMemoryLedger()
    stored = ledger.upsert_agent_version(_record(status="candidate"))
    assert stored.status == "active"
    assert ledger.active_version("add-feature").version == 1


def test_second_version_stays_candidate():
    ledger = InMemoryLedger()
    ledger.upsert_agent_version(_record(version=1, status="active"))
    stored = ledger.upsert_agent_version(_record(version=2, status="candidate"))
    assert stored.status == "candidate"
    assert ledger.active_version("add-feature").version == 1


def test_reupsert_of_existing_version_does_not_force_active():
    ledger = InMemoryLedger()
    ledger.upsert_agent_version(_record(version=1))
    ledger.set_version_status("add-feature", 1, "archived", reason="superseded")
    stored = ledger.upsert_agent_version(_record(version=1, status="archived"))
    assert stored.status == "archived", "an update must not resurrect the version"


# --- status transitions with events ---


def test_set_version_status_updates_record_and_appends_event():
    ledger = InMemoryLedger()
    ledger.upsert_agent_version(_record(version=1, status="active"))
    ledger.upsert_agent_version(_record(version=2, status="candidate"))

    updated = ledger.set_version_status(
        "add-feature", 2, "rejected", reason="safety regression"
    )
    assert updated.status == "rejected"
    assert updated.status_reason == "safety regression"
    assert updated.decided_at is not None
    assert ledger.get_agent_version("add-feature", 2).status == "rejected"

    events = ledger.events("agent:add-feature@2")
    assert [e.event_type for e in events] == ["version_status"]
    assert events[0].payload == {
        "name": "add-feature", "version": 2,
        "status": "rejected", "reason": "safety regression",
    }


def test_set_version_status_rejects_unknown_status_and_version():
    ledger = InMemoryLedger()
    ledger.upsert_agent_version(_record(version=1))
    with pytest.raises(ValueError):
        ledger.set_version_status("add-feature", 1, "bogus")
    with pytest.raises(KeyError):
        ledger.set_version_status("add-feature", 9, "rejected")


def test_canary_version_returns_latest_canary_only():
    ledger = InMemoryLedger()
    ledger.upsert_agent_version(_record(version=1, status="active"))
    assert ledger.canary_version("add-feature") is None
    ledger.upsert_agent_version(_record(version=2, status="candidate"))
    ledger.set_version_status("add-feature", 2, "canary", reason="auto-pass")
    canary = ledger.canary_version("add-feature")
    assert canary is not None and canary.version == 2


# --- promotion decisions carry lifecycle state; promotions(status=) filters ---


def test_decide_reject_is_a_resolved_rejected_decision():
    d = decide(_card(safety=1), _card(0.5, subject_id="add-feature@1"))
    assert d.decision is Decision.reject
    assert d.status == "rejected"
    assert d.resolved_at is not None
    assert d.id.startswith("prom_")


def test_decide_needs_human_is_a_pending_decision():
    d = decide(_card(), _card(0.5), mutation_kinds=["new-secret-access"])
    assert d.decision is Decision.needs_human
    assert d.status == "pending"
    assert d.resolved_at is None


def test_decide_auto_pass_is_an_approved_canary_decision():
    d = decide(_card(0.9), _card(0.5))
    assert d.decision is Decision.canary
    assert d.status == "approved"
    assert d.resolved_at is not None


def test_promotions_filters_by_status():
    ledger = InMemoryLedger()
    pending = decide(_card(), _card(0.5), mutation_kinds=["new-secret-access"])
    rejected = decide(_card(safety=1), _card(0.5))
    ledger.record_promotion(pending)
    ledger.record_promotion(rejected)

    assert {p.id for p in ledger.promotions()} == {pending.id, rejected.id}
    assert [p.id for p in ledger.promotions(status="pending")] == [pending.id]
    assert [p.id for p in ledger.promotions(status="rejected")] == [rejected.id]


def test_decision_to_dict_includes_lifecycle_fields():
    d = decide(_card(), _card(0.5), mutation_kinds=["new-secret-access"])
    doc = d.to_dict()
    assert doc["id"] == d.id
    assert doc["status"] == "pending"
    assert doc["approved_by"] is None
    assert doc["comment"] is None
    assert doc["resolved_at"] is None


def test_promotion_decision_defaults_are_pending():
    d = PromotionDecision(Decision.canary, "r", _card())
    assert d.status == "pending"


# --- decide() outcomes drive version transitions (design §1/§4, OPT-7) ---


def _ledger_with_candidate(version=2):
    ledger = InMemoryLedger()
    ledger.upsert_agent_version(_record(version=1, status="active"))
    ledger.upsert_agent_version(_record(version=version, status="candidate"))
    return ledger


def test_apply_decision_reject_transitions_candidate_to_rejected():
    from bakudo.evals.promotion import apply_decision

    ledger = _ledger_with_candidate()
    decision = decide(_card(safety=1), _card(0.5, subject_id="add-feature@1"))
    apply_decision(ledger, decision)

    assert ledger.get_agent_version("add-feature", 2).status == "rejected"
    assert ledger.promotions(status="rejected")[0].id == decision.id
    assert ledger.active_version("add-feature").version == 1


def test_apply_decision_human_gate_parks_candidate_pending_human():
    from bakudo.evals.promotion import apply_decision

    ledger = _ledger_with_candidate()
    decision = decide(_card(), _card(0.5), mutation_kinds=["new-secret-access"])
    apply_decision(ledger, decision)

    version = ledger.get_agent_version("add-feature", 2)
    assert version.status == "pending_human"
    pending = ledger.promotions(status="pending")
    assert [p.id for p in pending] == [decision.id]
    assert pending[0].gated_mutations == ["new-secret-access"]


def test_apply_decision_auto_pass_transitions_candidate_to_canary():
    from bakudo.evals.promotion import apply_decision

    ledger = _ledger_with_candidate()
    decision = decide(_card(0.9), _card(0.5, subject_id="add-feature@1"))
    apply_decision(ledger, decision)

    assert ledger.get_agent_version("add-feature", 2).status == "canary"
    assert ledger.canary_version("add-feature").version == 2
    assert ledger.active_version("add-feature").version == 1


def test_apply_decision_tolerates_non_version_subjects():
    from bakudo.evals.promotion import apply_decision

    ledger = InMemoryLedger()
    card = _card(subject_id="run_X")
    card.subject_type = "run"
    decision = decide(card, None)
    apply_decision(ledger, decision)  # must not raise
    assert len(ledger.promotions()) == 1


# --- human resolution of pending promotions (design §4, API-7) ---


def _pending_promotion(ledger):
    from bakudo.evals.promotion import apply_decision

    decision = decide(_card(), _card(0.5), mutation_kinds=["new-secret-access"])
    apply_decision(ledger, decision)
    return decision


def test_resolve_promotion_approve_moves_version_to_canary():
    ledger = _ledger_with_candidate()
    decision = _pending_promotion(ledger)

    resolved = ledger.resolve_promotion(
        decision.id, approved=True, approved_by="al", comment="scorecard is clean"
    )
    assert resolved.status == "approved"
    assert resolved.approved_by == "al"
    assert resolved.comment == "scorecard is clean"
    assert resolved.resolved_at is not None
    assert ledger.get_agent_version("add-feature", 2).status == "canary"
    assert ledger.promotions(status="pending") == []


def test_resolve_promotion_reject_moves_version_to_rejected():
    ledger = _ledger_with_candidate()
    decision = _pending_promotion(ledger)

    resolved = ledger.resolve_promotion(
        decision.id, approved=False, approved_by="al", comment="too risky"
    )
    assert resolved.status == "rejected"
    assert ledger.get_agent_version("add-feature", 2).status == "rejected"


def test_resolve_promotion_unknown_id_raises_key_error():
    ledger = _ledger_with_candidate()
    with pytest.raises(KeyError):
        ledger.resolve_promotion("prom_NOPE", approved=True, approved_by="al")


def test_resolve_promotion_twice_raises_value_error():
    ledger = _ledger_with_candidate()
    decision = _pending_promotion(ledger)
    ledger.resolve_promotion(decision.id, approved=True, approved_by="al")
    with pytest.raises(ValueError):
        ledger.resolve_promotion(decision.id, approved=False, approved_by="al")


# --- completed_runs: the graduation window read (design §3) ---


def test_completed_runs_filters_by_ref_and_orders_recent_first():
    from bakudo.registry.records import RunPhase, RunRecord

    ledger = InMemoryLedger()
    for i, (ref, finish) in enumerate(
        [("explore@2", True), ("explore@1", True), ("explore@2", True),
         ("explore@2", False)]
    ):
        run_id = f"run_CR{i}"
        ledger.create_run(
            RunRecord(
                id=run_id, temporal_workflow_id=f"wf-{i}", abox_task_id=run_id,
                objective_id="obj_CR", agent_ref=ref,
            )
        )
        if finish:
            ledger.finish_run(run_id, RunPhase.completed, {})

    runs = ledger.completed_runs("explore@2")
    assert [r.id for r in runs] == ["run_CR2", "run_CR0"], "recent first, completed only"
    assert [r.id for r in ledger.completed_runs("explore@2", limit=1)] == ["run_CR2"]


# --- deterministic canary routing (design §2) ---


def test_routes_to_canary_is_deterministic_and_percent_bounded():
    from bakudo.evals.promotion import routes_to_canary

    # sha256("run_CANARYB") % 100 == 3; sha256("run_CANARYA") % 100 == 79.
    assert routes_to_canary("run_CANARYB", 10) is True
    assert routes_to_canary("run_CANARYA", 10) is False
    assert routes_to_canary("run_CANARYA", 100) is True
    assert routes_to_canary("run_CANARYB", 0) is False
    # Same run id, same answer, every time (replay-safe inside Temporal).
    assert all(routes_to_canary("run_CANARYB", 10) for _ in range(5))


# --- compare-and-set guard on version transitions (TMP-23) ---


def test_set_version_status_expected_status_is_a_no_op_on_mismatch():
    """The canary-graduation compare-and-set: transitioning with an
    expected_status that no longer matches is a no-op returning None (a lost
    race), and does not change the row."""
    ledger = InMemoryLedger()
    ledger.upsert_agent_version(_record(name="explore", version=2, status="candidate"))
    ledger.set_version_status("explore", 2, "canary", reason="auto")

    # First graduation wins.
    first = ledger.set_version_status(
        "explore", 2, "active", reason="graduated", expected_status="canary"
    )
    assert first is not None and first.status == "active"

    # A second, concurrent graduation observes canary already gone -> no-op.
    second = ledger.set_version_status(
        "explore", 2, "active", reason="graduated again", expected_status="canary"
    )
    assert second is None
    assert ledger.get_agent_version("explore", 2).status == "active"
    assert ledger.get_agent_version("explore", 2).status_reason == "graduated"


def test_repeated_canary_graduation_promotes_once(monkeypatch):
    """check_canary_graduation is safe to call more than once for the same
    canary: the first graduates (one promotion, one archive); a later call is a
    clean no-op that records no duplicate. The compare-and-set primitive that
    also closes the truly-concurrent window is covered by
    test_set_version_status_expected_status_is_a_no_op_on_mismatch (TMP-23)."""
    from bakudo.evals.promotion import PromotionPolicy
    from bakudo.temporal import _impl

    ledger = InMemoryLedger()
    ledger.upsert_agent_version(_record(name="explore", version=1, status="active"))
    ledger.upsert_agent_version(_record(name="explore", version=2, status="candidate"))
    ledger.set_version_status("explore", 2, "canary", reason="auto")

    # One completed canary run with a clean scorecard, enough to satisfy a
    # min-runs-of-1 policy.
    from bakudo.registry.records import RunPhase, RunRecord

    ledger.create_run(
        RunRecord(id="run_C1", temporal_workflow_id="wf", abox_task_id="run_C1",
                  objective_id="obj", agent_ref="explore@2")
    )
    ledger.set_phase("run_C1", RunPhase.agent_running)
    ledger.finish_run("run_C1", RunPhase.completed, {"status": "success"})
    from bakudo.evals.result import EvalResult

    ledger.record_eval(EvalResult(
        subject_type="run", subject_id="run_C1", suite_name="task",
        score=0.9, passed=True,
    ))

    monkeypatch.setattr(_impl.DEPS, "ledger", ledger)
    monkeypatch.setattr(_impl, "PROMOTION_POLICY", PromotionPolicy(canary_min_runs=1))

    first = _impl.check_canary_graduation("explore")
    second = _impl.check_canary_graduation("explore")

    assert first["status"] == "graduated"
    # The canary is already active, so the repeat is a safe no-op — never a
    # second graduation.
    assert second["status"] in ("no-canary", "already-resolved")
    assert ledger.get_agent_version("explore", 2).status == "active"
    assert ledger.get_agent_version("explore", 1).status == "archived"
    promotions = [d for d in ledger.promotions() if d.approved_by == "canary-graduation"]
    assert len(promotions) == 1, "the second graduation must not record a duplicate"
