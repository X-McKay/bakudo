"""Phase B2: pin the abox invocation protocol with a fake executor."""

import json
from pathlib import Path

from bakudo.abox.runner import AboxRunner, ExecResult
from bakudo.agent_spec import load_spec_file
from bakudo.bundle import Budget, TaskBundle
from bakudo.curriculum import Objective

AGENTS = Path(__file__).resolve().parents[1] / "agents"


def _bundle():
    spec = load_spec_file(AGENTS / "explore.yaml")
    objective = Objective(type="explore", repo="bakudo", title="map it")
    return TaskBundle(
        run_id="run_TEST01",
        objective_id=objective.id,
        objective=objective,
        agent_spec=spec,
        budget=Budget(timeoutSeconds=spec.sandbox.timeout_seconds),
    )


def test_build_command_shape():
    runner = AboxRunner()
    cmd = runner.build_command(_bundle(), Path("/tmp/meta"))
    assert cmd[:2] == ["abox", "run"]
    assert "--task" in cmd and "run_TEST01" in cmd
    assert "agent-runner" in cmd
    assert cmd[cmd.index("--branch") + 1] == "agent/run_TEST01"
    # The runner is invoked with the bundle and a result path inside the mount.
    assert "--bundle" in cmd and "--result" in cmd


def test_runner_writes_bundle_and_collects_result():
    written = {}

    def fake_abox(argv):
        # Simulate abox: read the host side of the --mount, drop a result.json
        # where the runner would have written it, and exit 0.
        mount = argv[argv.index("--mount") + 1]
        host_dir = Path(mount.split(":")[0])
        written["files"] = sorted(p.name for p in host_dir.iterdir())
        (host_dir / "result.json").write_text(
            json.dumps(
                {
                    "run_id": "run_TEST01",
                    "agent": "explore@1",
                    "objective_id": "obj_X",
                    "status": "success",
                    "summary": "mapped",
                    "changed_files": ["notes.md"],
                }
            )
        )
        return ExecResult(0, "done", "")

    runner = AboxRunner(executor=fake_abox)
    outcome = runner.run(_bundle())

    # The task bundle parts were materialised into the mount.
    assert {"agent.yaml", "bundle.json", "objective.json"} <= set(written["files"])
    # The result was collected and surfaced.
    assert outcome.succeeded
    assert outcome.result["status"] == "success"
    assert outcome.changed_files == ["notes.md"]
    assert outcome.git_branch == "agent/run_TEST01"
