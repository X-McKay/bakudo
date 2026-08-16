import subprocess

import yaml

from bakudo.scenarios.provision import ProvisionedWorkspace, provision
from bakudo.scenarios.registry import ScenarioRegistry

# Mirrors tests/test_scenario_models.py::MINIMAL (Task 1). Kept as a local
# copy rather than a cross-module import so this file stands alone under
# pytest's rootdir-relative import mode (tests/ has no __init__.py).
MINIMAL = {
    "apiVersion": "bakudo.ai/v1alpha1",
    "kind": "ScenarioSpec",
    "metadata": {
        "name": "sample-bug", "version": 1, "family": "debugging",
        "difficulty": "easy", "tags": ["python"], "partition": "dev",
        "canary": "bakudo-canary-TESTGUID",
        "provenance": {"createdBy": "human", "createdAt": "2026-08-15",
                       "sourceType": "hand-written", "eligibleForPromotion": True},
    },
    "mission": {"type": "qa", "title": "Fix the bug", "description": "There is a bug.",
                "acceptanceCriteria": ["tests pass"], "constraints": {"maxFilesChanged": 2}},
    "environment": {"profile": "python-glibc", "network": "none"},
    "budgets": {"wallSeconds": 600, "toolCalls": 30, "tokens": 20000},
    "hidden": {"failToPass": ["hidden/test_bug.py"], "passToPass": ["hidden/test_ok.py"],
               "testCommand": "pytest {files} -q", "wrongFixProbes": [], "expectedFiles": ["app.py"]},
    "expect": {"status": "success", "changesPaths": ["app.py"], "maxChangedFiles": 2,
               "forbidsDeniedCommands": True, "testPathsImmutable": True},
}


def make_scenario_dir(parent, name="sample-bug"):
    """Write a minimal-but-realistic scenario dir under parent/name,
    including a hidden/ and a reference/ directory that must never end up
    in a provisioned workspace."""
    d = parent / name
    d.mkdir(parents=True, exist_ok=True)
    (d / "scenario.yaml").write_text(yaml.safe_dump(MINIMAL, sort_keys=False))

    fixture = d / "fixture"
    fixture.mkdir()
    (fixture / "app.py").write_text("def app():\n    return 1\n")
    nested = fixture / "pkg"
    nested.mkdir()
    (nested / "__init__.py").write_text("")

    hidden = d / "hidden"
    hidden.mkdir()
    (hidden / "test_bug.py").write_text("def test_bug():\n    assert app() == 1\n")

    reference = d / "reference"
    reference.mkdir()
    (reference / "solution.py").write_text("def app():\n    return 1\n")

    return d


def load_loaded_scenario(tmp_path, name="sample-bug"):
    root = tmp_path / "scenarios"
    root.mkdir(exist_ok=True)
    make_scenario_dir(root, name=name)
    registry = ScenarioRegistry(root)
    return registry.get(f"{name}@1")


def test_provision_bytes_identical(tmp_path):
    scn = load_loaded_scenario(tmp_path)
    ws1 = provision(scn, tmp_path / "a", seed=7)
    ws2 = provision(scn, tmp_path / "b", seed=7)
    assert isinstance(ws1, ProvisionedWorkspace)
    assert ws1.base_ref == ws2.base_ref  # identical commit sha = identical bytes+metadata


def test_hidden_and_reference_not_in_workspace(tmp_path):
    scn = load_loaded_scenario(tmp_path)
    ws = provision(scn, tmp_path / "w", seed=1)
    names = {p.name for p in ws.repo_path.rglob("*")}
    assert "test_bug.py" not in names
    assert "reference" not in names
    assert "solution.py" not in names
    # sanity: fixture content did make it in.
    assert "app.py" in names
    assert (ws.repo_path / "pkg" / "__init__.py").is_file()


def test_repo_is_git_with_single_commit(tmp_path):
    scn = load_loaded_scenario(tmp_path)
    ws = provision(scn, tmp_path / "w", seed=1)
    result = subprocess.run(
        ["git", "rev-list", "--count", "HEAD"],
        cwd=ws.repo_path,
        check=True,
        capture_output=True,
        text=True,
    )
    assert result.stdout.strip() == "1"
    result = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=ws.repo_path,
        check=True,
        capture_output=True,
        text=True,
    )
    assert result.stdout.strip() == ws.base_ref


def test_provision_returns_seed(tmp_path):
    scn = load_loaded_scenario(tmp_path)
    ws = provision(scn, tmp_path / "w", seed=42)
    assert ws.seed == 42
    assert ws.repo_path == (tmp_path / "w" / "repo")
