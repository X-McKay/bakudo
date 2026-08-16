"""``local_sandbox`` in-place workspace reuse tests (F5 fix).

``local_sandbox`` reuses an absolute, ``.git``-bearing ``objective.repo`` in
place instead of fabricating a fresh scratch repo -- see
``tests/test_temporal_experiments.py::
test_provision_trial_local_sandbox_uses_provisioned_fixture`` for the
positive case (a scenario's own provisioned fixture, always under the system
temp root, must be used in place). This file covers the negative case: an
absolute ``.git``-bearing path OUTSIDE the system temp root (e.g. a real,
non-scratch checkout a dev-mode observer objective happens to point at) must
NOT be reused in place -- that would let the agent mutate it directly.
"""

from __future__ import annotations

import json
import subprocess
import tempfile
from pathlib import Path

from bakudo.abox.local import local_sandbox
from bakudo.agent_spec import load_spec_file
from bakudo.bundle import Budget, TaskBundle
from bakudo.curriculum.objective import Objective

AGENTS = Path(__file__).resolve().parents[1] / "agents"


def _git_init(path: Path) -> None:
    subprocess.run(["git", "init", "-q"], cwd=path, check=True)


def test_local_sandbox_outside_temp_root_does_not_mutate_real_repo(tmp_path, monkeypatch):
    # Redirect the "system temp root" the fix checks against to a
    # subdirectory of tmp_path, then place the "real checkout" as a SIBLING
    # directory outside it -- deterministic regardless of where the actual
    # OS temp dir lives.
    fake_temp_root = tmp_path / "faketmp"
    fake_temp_root.mkdir()
    monkeypatch.setattr(tempfile, "gettempdir", lambda: str(fake_temp_root))

    outside_repo = tmp_path / "real-checkout"
    outside_repo.mkdir()
    _git_init(outside_repo)
    marker = outside_repo / "secret.txt"
    marker.write_text("do not touch")

    spec = load_spec_file(AGENTS / "add-feature.yaml")
    objective = Objective(type="add-feature", repo=str(outside_repo), title="peek")
    bundle = TaskBundle(
        run_id="run_outsiderepo1",
        objective_id=objective.id,
        objective=objective,
        agent_spec=spec,
        budget=Budget(timeoutSeconds=60),
    )

    def driver(system_prompt, user_prompt, tools):
        tools["edit-file"](path="secret.txt", content="mutated by agent\n")
        return json.dumps(
            {
                "status": "success",
                "summary": "wrote",
                "changedFiles": ["secret.txt"],
                "proposedFollowups": [],
                "memoriesToWrite": [],
            }
        )

    outcome = local_sandbox(bundle, offline_driver=driver)

    assert marker.read_text() == "do not touch", (
        "local_sandbox must not run in place against an absolute repo path "
        "outside the system temp root"
    )
    assert outcome.result["status"] == "success"


def test_local_sandbox_under_temp_root_still_reuses_in_place(tmp_path, monkeypatch):
    """Control case: a provisioned-style workspace under the (real) temp
    root is still reused in place -- the fix must not regress the trial
    provisioner's intended behavior (also covered end to end by
    test_temporal_experiments.py's provisioned-fixture integration test)."""
    fake_temp_root = tmp_path / "faketmp"
    fake_temp_root.mkdir()
    monkeypatch.setattr(tempfile, "gettempdir", lambda: str(fake_temp_root))

    inside_repo = fake_temp_root / "provisioned-ws"
    inside_repo.mkdir()
    _git_init(inside_repo)
    marker = inside_repo / "secret.txt"
    marker.write_text("do not touch")

    spec = load_spec_file(AGENTS / "add-feature.yaml")
    objective = Objective(type="add-feature", repo=str(inside_repo), title="peek")
    bundle = TaskBundle(
        run_id="run_insiderepo1",
        objective_id=objective.id,
        objective=objective,
        agent_spec=spec,
        budget=Budget(timeoutSeconds=60),
    )

    def driver(system_prompt, user_prompt, tools):
        tools["edit-file"](path="secret.txt", content="mutated by agent\n")
        return json.dumps(
            {
                "status": "success",
                "summary": "wrote",
                "changedFiles": ["secret.txt"],
                "proposedFollowups": [],
                "memoriesToWrite": [],
            }
        )

    outcome = local_sandbox(bundle, offline_driver=driver)

    assert marker.read_text() == "mutated by agent\n", (
        "a workspace under the temp root must still be reused in place"
    )
    assert outcome.result["status"] == "success"
