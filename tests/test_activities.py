"""Phase A2/A4: ledger routing is backend-agnostic and sandbox fails closed."""

import pytest

from bakudo.temporal import _impl
from bakudo.temporal._impl import Deps
from bakudo.temporal.shared import AgentRunInput


class SpyLedger:
    """A minimal Ledger-Protocol implementation that records calls."""

    def __init__(self):
        self.created = []
        self.objectives = []
        self.phases = []
        self.finished = []

    def create_run(self, record, objective=None):
        self.created.append(record)
        self.objectives.append(objective)
        return record

    def set_phase(self, run_id, phase):
        self.phases.append((run_id, phase))

    def finish_run(self, run_id, phase, result):
        self.finished.append((run_id, phase, result))


@pytest.fixture
def spy(monkeypatch):
    s = SpyLedger()
    monkeypatch.setattr(_impl.DEPS, "ledger", s)
    return s


def _input():
    return AgentRunInput(
        run_id="run_X",
        objective={"id": "obj_X", "type": "explore"},
        agent_spec={"metadata": {"name": "explore", "version": 1}},
    )


def test_create_run_routes_to_configured_ledger(spy):
    out = _impl.create_run(_input(), workflow_id="wf-1")
    assert out["run_id"] == "run_X"
    assert spy.created and spy.created[0].temporal_workflow_id == "wf-1"
    assert spy.created[0].agent_ref == "explore@1"


def test_create_run_passes_objective_for_upsert(spy):
    """TMP-2: the ledger needs the objective document so the runs FK holds."""
    _impl.create_run(_input(), workflow_id="wf-1")
    assert spy.objectives == [{"id": "obj_X", "type": "explore"}]


def test_persist_run_routes_non_terminal_and_terminal(spy):
    _impl.persist_run("run_X", "agent_running", {})
    _impl.persist_run("run_X", "completed", {"result": {"ok": True}})
    assert ("run_X",) == (spy.phases[0][0],)
    assert spy.finished and spy.finished[0][2] == {"ok": True}


# --- TMP-3: agent spec loading for meta dispatch ---

def test_load_agent_spec_from_repo_yaml(spy):
    doc = _impl.load_agent_spec("explore")
    assert doc is not None and doc["metadata"]["name"] == "explore"


def test_load_agent_spec_unknown_returns_none(spy):
    assert _impl.load_agent_spec("no-such-agent") is None


def test_load_agent_spec_rejects_path_traversal(spy):
    assert _impl.load_agent_spec("../agents/explore") is None


def test_load_agent_spec_prefers_ledger_active_version(monkeypatch):
    from bakudo.registry import InMemoryLedger
    from bakudo.registry.records import AgentVersionRecord

    ledger = InMemoryLedger()
    ledger.upsert_agent_version(
        AgentVersionRecord(
            name="explore", version=7,
            spec_yaml="metadata:\n  name: explore\n  version: 7\n",
            status="active",
        )
    )
    monkeypatch.setattr(_impl.DEPS, "ledger", ledger)
    doc = _impl.load_agent_spec("explore")
    assert doc == {"metadata": {"name": "explore", "version": 7}}


def _seed_versions(monkeypatch):
    from bakudo.registry import InMemoryLedger
    from bakudo.registry.records import AgentVersionRecord

    ledger = InMemoryLedger()
    for version, status in ((7, "active"), (8, "candidate")):
        ledger.upsert_agent_version(
            AgentVersionRecord(
                name="explore", version=version,
                spec_yaml=f"metadata:\n  name: explore\n  version: {version}\n",
                status=status,
            )
        )
    monkeypatch.setattr(_impl.DEPS, "ledger", ledger)
    return ledger


def test_load_agent_spec_routes_to_canary_deterministically(monkeypatch):
    """Design §2 in the Temporal dispatch path: sha256('run_CANARYB') % 100 == 3
    (< 10 -> canary), sha256('run_CANARYA') % 100 == 79 (>= 10 -> active)."""
    ledger = _seed_versions(monkeypatch)
    ledger.set_version_status("explore", 8, "canary")
    assert _impl.load_agent_spec("explore", "run_CANARYB")["metadata"]["version"] == 8
    assert _impl.load_agent_spec("explore", "run_CANARYA")["metadata"]["version"] == 7


def test_load_agent_spec_never_returns_non_canary_candidates(monkeypatch):
    ledger = _seed_versions(monkeypatch)
    assert _impl.load_agent_spec("explore", "run_CANARYB")["metadata"]["version"] == 7
    ledger.set_version_status("explore", 8, "rejected")
    assert _impl.load_agent_spec("explore", "run_CANARYB")["metadata"]["version"] == 7


# --- canary graduation (design §3, OPT-6) ---


def _graduation_ledger(monkeypatch, *, min_runs=3):
    from bakudo.evals.promotion import PromotionPolicy
    from bakudo.registry import InMemoryLedger
    from bakudo.registry.records import AgentVersionRecord

    ledger = InMemoryLedger()
    for version, status in ((1, "active"), (2, "candidate")):
        ledger.upsert_agent_version(
            AgentVersionRecord(
                name="explore", version=version, status=status,
                spec_yaml=f"metadata:\n  name: explore\n  version: {version}\n",
            )
        )
    ledger.set_version_status("explore", 2, "canary", reason="auto-pass")
    monkeypatch.setattr(_impl.DEPS, "ledger", ledger)
    monkeypatch.setattr(
        _impl, "PROMOTION_POLICY", PromotionPolicy(canary_min_runs=min_runs)
    )
    return ledger


def _completed_run(ledger, ref, run_id, score, *, safety_regressions=0):
    from bakudo.evals.result import EvalResult
    from bakudo.registry.records import RunPhase, RunRecord

    ledger.create_run(
        RunRecord(
            id=run_id, temporal_workflow_id=f"wf-{run_id}", abox_task_id=run_id,
            objective_id="obj_GRAD", agent_ref=ref,
        )
    )
    ledger.finish_run(run_id, RunPhase.completed, {})
    ledger.record_eval(
        EvalResult(
            subject_type="run", subject_id=run_id, suite_name="task",
            score=score, passed=True,
            details={"safety_regressions": safety_regressions},
        )
    )


def test_graduation_no_canary_is_a_noop(monkeypatch):
    from bakudo.registry import InMemoryLedger

    monkeypatch.setattr(_impl.DEPS, "ledger", InMemoryLedger())
    assert _impl.check_canary_graduation("explore")["status"] == "no-canary"


def test_graduation_waits_for_min_runs(monkeypatch):
    ledger = _graduation_ledger(monkeypatch, min_runs=3)
    _completed_run(ledger, "explore@2", "run_G1", 0.9)
    out = _impl.check_canary_graduation("explore")
    assert out["status"] == "insufficient-runs"
    assert ledger.get_agent_version("explore", 2).status == "canary", "no transition yet"


def test_graduation_promotes_better_canary_and_archives_old_active(monkeypatch):
    ledger = _graduation_ledger(monkeypatch, min_runs=3)
    for i in range(3):
        _completed_run(ledger, "explore@1", f"run_A{i}", 0.6)
        _completed_run(ledger, "explore@2", f"run_C{i}", 0.9)

    out = _impl.check_canary_graduation("explore")
    assert out["status"] == "graduated"
    assert ledger.get_agent_version("explore", 2).status == "active"
    assert ledger.get_agent_version("explore", 1).status == "archived"
    assert ledger.active_version("explore").version == 2
    # The transition was recorded as a promote decision with events.
    decisions = ledger.promotions()
    assert any(d.decision.value == "promote" for d in decisions)
    assert any(
        e.event_type == "version_status"
        for e in ledger.events("agent:explore@2")
    )


def test_graduation_equal_scores_still_graduate(monkeypatch):
    """Better-OR-EQUAL graduates (design §3)."""
    ledger = _graduation_ledger(monkeypatch, min_runs=2)
    for i in range(2):
        _completed_run(ledger, "explore@1", f"run_A{i}", 0.8)
        _completed_run(ledger, "explore@2", f"run_C{i}", 0.8)
    assert _impl.check_canary_graduation("explore")["status"] == "graduated"


def test_graduation_rolls_back_worse_canary(monkeypatch):
    ledger = _graduation_ledger(monkeypatch, min_runs=2)
    for i in range(2):
        _completed_run(ledger, "explore@1", f"run_A{i}", 0.9)
        _completed_run(ledger, "explore@2", f"run_C{i}", 0.6)

    out = _impl.check_canary_graduation("explore")
    assert out["status"] == "rolled-back"
    assert ledger.get_agent_version("explore", 2).status == "rejected"
    assert ledger.active_version("explore").version == 1
    assert any(d.decision.value == "reject" for d in ledger.promotions())


def test_graduation_rolls_back_on_safety_regression_despite_score(monkeypatch):
    ledger = _graduation_ledger(monkeypatch, min_runs=2)
    for i in range(2):
        _completed_run(ledger, "explore@1", f"run_A{i}", 0.5)
        _completed_run(
            ledger, "explore@2", f"run_C{i}", 0.95, safety_regressions=1
        )

    out = _impl.check_canary_graduation("explore")
    assert out["status"] == "rolled-back"
    assert ledger.get_agent_version("explore", 2).status == "rejected"


def test_graduation_without_active_baseline_runs_graduates_clean_canary(monkeypatch):
    ledger = _graduation_ledger(monkeypatch, min_runs=2)
    for i in range(2):
        _completed_run(ledger, "explore@2", f"run_C{i}", 0.9)
    assert _impl.check_canary_graduation("explore")["status"] == "graduated"


# --- integration hook: budget_from_spec (abox agent's contract) ---

def test_render_bundle_uses_budget_from_spec_when_available(monkeypatch, spy):
    import bakudo.bundle as bundle_mod
    from bakudo.bundle import Budget

    calls = []

    def fake_budget_from_spec(spec):
        calls.append(spec)
        return Budget(timeoutSeconds=1234)

    monkeypatch.setattr(
        bundle_mod, "budget_from_spec", fake_budget_from_spec, raising=False
    )
    spec = _impl.load_agent_spec("explore")
    out = _impl.render_bundle(
        AgentRunInput(
            run_id="run_BUD1",
            objective={"id": "obj_BUD1", "type": "explore", "repo": "r", "title": "t"},
            agent_spec=spec,
            timeout_seconds=99,
        )
    )
    assert calls, "budget_from_spec was not consulted"
    assert out["budget"]["timeoutSeconds"] == 1234


def test_render_bundle_uses_real_budget_from_spec(spy):
    """Integration seam: with the real ``bakudo.bundle.budget_from_spec``
    landed, the bundle budget comes from the spec's sandbox timeout, not the
    workflow input's ``timeout_seconds`` fallback."""
    import bakudo.bundle as bundle_mod

    assert hasattr(bundle_mod, "budget_from_spec")
    spec = _impl.load_agent_spec("explore")
    out = _impl.render_bundle(
        AgentRunInput(
            run_id="run_BUD2",
            objective={"id": "obj_BUD2", "type": "explore", "repo": "r", "title": "t"},
            agent_spec=spec,
            timeout_seconds=555,
        )
    )
    # agents/explore.yaml sandbox.timeoutSeconds — the single wall-clock number.
    assert out["budget"]["timeoutSeconds"] == 1800


# --- TMP-12: run_sandbox heartbeats from its worker thread ---

def test_run_sandbox_heartbeats_while_the_sandbox_runs(monkeypatch):
    """A silent worker crash during a 2h sandbox run must be detectable via
    heartbeat_timeout, so the sync activity heartbeats on a side thread."""
    import time

    from temporalio.testing import ActivityEnvironment

    from bakudo.abox.runner import AboxOutcome
    from bakudo.temporal import activities

    def slow_sandbox(bundle):
        time.sleep(0.15)
        return AboxOutcome(
            run_id=bundle.run_id, abox_task_id=bundle.run_id,
            exit_code=0, git_branch="agent/run_HB",
            result={"run_id": bundle.run_id, "agent": "explore@1",
                    "objective_id": bundle.objective_id,
                    "status": "success", "summary": "ok"},
        )

    monkeypatch.setattr(activities, "_HEARTBEAT_INTERVAL_SECONDS", 0.01)
    monkeypatch.setattr(_impl.DEPS, "sandbox", slow_sandbox)

    spec = _impl.load_agent_spec("explore")
    bundle = _impl.render_bundle(
        AgentRunInput(
            run_id="run_HB",
            objective={"id": "obj_HB", "type": "explore", "repo": "r", "title": "t"},
            agent_spec=spec,
        )
    )

    beats = []
    env = ActivityEnvironment()
    env.on_heartbeat = lambda *args: beats.append(args)
    out = env.run(activities.run_sandbox, bundle)
    assert out["succeeded"] is True
    assert len(beats) >= 3, f"expected periodic heartbeats, got {len(beats)}"


def test_run_sandbox_works_outside_an_activity_context(monkeypatch):
    """Direct calls (unit tests, tooling) must not require a Temporal context."""
    from bakudo.abox.runner import AboxOutcome
    from bakudo.temporal import activities

    def sandbox(bundle):
        return AboxOutcome(
            run_id=bundle.run_id, abox_task_id=bundle.run_id,
            exit_code=0, git_branch="agent/run_HB2",
            result={"run_id": bundle.run_id, "agent": "explore@1",
                    "objective_id": bundle.objective_id,
                    "status": "success", "summary": "ok"},
        )

    monkeypatch.setattr(_impl.DEPS, "sandbox", sandbox)
    spec = _impl.load_agent_spec("explore")
    bundle = _impl.render_bundle(
        AgentRunInput(
            run_id="run_HB2",
            objective={"id": "obj_HB2", "type": "explore", "repo": "r", "title": "t"},
            agent_spec=spec,
        )
    )
    assert activities.run_sandbox(bundle)["succeeded"] is True


# --- A4: fail-closed sandbox selection ---

def _clear_sandbox_env(monkeypatch):
    for var in ("BAKUDO_SANDBOX", "BAKUDO_USE_ABOX", "BAKUDO_ENV"):
        monkeypatch.delenv(var, raising=False)


def test_sandbox_fn_raises_when_unset(monkeypatch):
    _clear_sandbox_env(monkeypatch)
    with pytest.raises(RuntimeError, match="BAKUDO_SANDBOX"):
        Deps().sandbox_fn()


def test_sandbox_local_requires_dev(monkeypatch):
    _clear_sandbox_env(monkeypatch)
    monkeypatch.setenv("BAKUDO_SANDBOX", "local")
    with pytest.raises(RuntimeError, match="dev"):
        Deps().sandbox_fn()
    monkeypatch.setenv("BAKUDO_ENV", "dev")
    assert callable(Deps().sandbox_fn())


def test_sandbox_abox_selected(monkeypatch):
    _clear_sandbox_env(monkeypatch)
    monkeypatch.setenv("BAKUDO_SANDBOX", "abox")
    assert callable(Deps().sandbox_fn())


def test_run_sandbox_dict_carries_error_and_stderr_tail(monkeypatch):
    """Failed runs must leave diagnosable breadcrumbs in the durable event
    payloads — live cycles were undiagnosable without them."""
    from bakudo.abox.runner import AboxOutcome
    from bakudo.temporal import _impl

    def broken(bundle):
        return AboxOutcome(
            run_id=bundle.run_id, abox_task_id=bundle.run_id, exit_code=1,
            git_branch="b", result=None, stderr="x" * 3000 + "the real cause",
            error="no result.json at /w/.agent/result.json",
        )

    monkeypatch.setattr(_impl.DEPS, "sandbox", broken)
    inp = AgentRunInput(
        run_id="run_ERR1",
        objective={"id": "obj_ERR1", "type": "explore", "repo": "r", "title": "t"},
        agent_spec=_impl.load_agent_spec("explore"),
    )
    out = _impl.run_sandbox(_impl.render_bundle(inp))
    assert out["error"] == "no result.json at /w/.agent/result.json"
    assert out["stderr"].endswith("the real cause") and len(out["stderr"]) <= 2000
