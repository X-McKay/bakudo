"""Offline in-sandbox e2e against the *real* abox 0.7.2 binary.

Skipped unless ``ABOX_LIVE=1``: these tests boot KVM microVMs and need the
repo trusted (``abox project trust``) and warmed (``abox env warm``). They run
fully offline (``BAKUDO_OFFLINE=1`` inside the guest — the explore spec's
``networkMode: none`` maps to abox ``--network safe`` anyway).

Acceptance:

- a schema-valid ``result.json`` is collected from the abox worktree,
- branch ``agent/<run_id>`` exists while the sandbox lives,
- cleanup leaves no worktree or branch behind,
- a second run with the same run id does not collide.
"""

import os
import subprocess
from pathlib import Path

import pytest

from bakudo.abox.runner import AboxRunner, _subprocess_executor
from bakudo.agent_run_bundle import AgentRunBundle, budget_from_spec
from bakudo.agent_spec import load_spec_file
from bakudo.curriculum import Objective

REPO = Path(__file__).resolve().parents[1]
RUN_ID = "run_E2EOFF1"
BRANCH = f"agent/{RUN_ID}"

pytestmark = [
    pytest.mark.live_abox,
    pytest.mark.skipif(
        os.environ.get("ABOX_LIVE") != "1",
        reason="live abox e2e: set ABOX_LIVE=1 (needs KVM + trusted/warmed repo)",
    ),
]


def _current_branch() -> str:
    proc = subprocess.run(
        ["git", "-C", str(REPO), "rev-parse", "--abbrev-ref", "HEAD"],
        capture_output=True,
        text=True,
        check=True,
    )
    return proc.stdout.strip()


def _bundle(run_id: str = RUN_ID) -> AgentRunBundle:
    spec = load_spec_file(REPO / "agents" / "explore.yaml")
    # Fork from the branch under test, not the spec's default `main`: the
    # guest's editable install resolves to /workspace, so the sandboxed run
    # must contain the code being validated.
    spec.sandbox.base_ref = _current_branch()
    objective = Objective(type="explore", repo="bakudo", title="offline in-sandbox e2e")
    return AgentRunBundle(
        run_id=run_id,
        objective_id=objective.id,
        objective=objective,
        agent_spec=spec,
        budget=budget_from_spec(spec),
    )


def _branch_exists() -> bool:
    proc = subprocess.run(
        ["git", "-C", str(REPO), "branch", "--list", BRANCH],
        capture_output=True,
        text=True,
        check=True,
    )
    return BRANCH in proc.stdout


class _BranchSpy:
    """Real executor + a branch-existence snapshot right after `abox run`."""

    def __init__(self):
        self.branch_existed_during_run: bool | None = None

    def __call__(self, argv, timeout=None):
        result = _subprocess_executor(argv, timeout)
        if argv[1] == "run":
            self.branch_existed_during_run = _branch_exists()
        return result


def _run_offline(monkeypatch, executor=None):
    monkeypatch.setenv("BAKUDO_OFFLINE", "1")
    runner = AboxRunner(repo_root=REPO, executor=executor)
    return runner.run(_bundle())


def test_offline_in_sandbox_e2e_collects_schema_valid_result(monkeypatch):
    spy = _BranchSpy()
    outcome = _run_offline(monkeypatch, executor=spy)

    # Result was produced in-guest and collected + schema-validated host-side.
    assert outcome.result is not None, (outcome.error, outcome.stderr[-2000:])
    assert outcome.result["status"] == "blocked"  # offline driver: no model
    assert "offline_mode" in outcome.result["blocked_reasons"]
    assert outcome.result["run_id"] == RUN_ID
    assert outcome.exit_code == 0
    assert not outcome.timed_out

    # The guest self-reported observability (ABOX-10).
    assert outcome.result["metrics"]["runtime_seconds"] >= 0.0

    # Branch existed while the sandbox lived; cleanup removed it (ABOX-8).
    assert spy.branch_existed_during_run is True
    assert not _branch_exists()

    # Second identical run id does not collide with leftovers.
    second = _run_offline(monkeypatch)
    assert second.result is not None, (second.error, second.stderr[-2000:])
    assert not _branch_exists()


def test_real_abox_timeout_is_distinguishable(monkeypatch):
    # `abox run --timeout 5` around a hanging command exits 124 (like GNU
    # timeout); the runner surfaces that as a timed_out outcome, not a
    # generic failure. Uses the raw executor to avoid a 30-minute spec run.
    result = _subprocess_executor(
        [
            "abox",
            "run",
            "--repo",
            str(REPO),
            "--task",
            "run_E2ETMO1",
            "--base",
            "main",
            "--timeout",
            "5",
            "--network",
            "safe",
            "--",
            "sleep",
            "999",
        ],
        timeout=120,
    )
    subprocess.run(
        ["abox", "stop", "--clean", "run_E2ETMO1", "--repo", str(REPO)],
        capture_output=True,
        text=True,
    )
    assert result.exit_code == 124
