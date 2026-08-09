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
