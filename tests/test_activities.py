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
