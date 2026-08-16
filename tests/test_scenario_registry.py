import copy
import json

import pytest
import yaml

from bakudo.scenarios.registry import (
    LoadedScenario,
    ScenarioRegistry,
    check_immutability,
    load_scenario,
    scenario_digest,
    update_lock,
)

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
               "testCommand": "pytest {files} -q", "wrongFixProbes": [],
               "expectedFiles": ["app.py"]},
    "expect": {"status": "success", "changesPaths": ["app.py"], "maxChangedFiles": 2,
               "forbidsDeniedCommands": True, "testPathsImmutable": True},
}


def make_scenario_dir(parent, name="sample-bug", overrides=None):
    """Write a scenario dir (MINIMAL + overrides) under parent/name."""
    spec = copy.deepcopy(MINIMAL)
    spec["metadata"]["name"] = name
    if overrides:
        for path, value in overrides.items():
            target = spec
            *parts, last = path.split(".")
            for part in parts:
                target = target[part]
            target[last] = value

    d = parent / name
    d.mkdir(parents=True, exist_ok=True)
    (d / "scenario.yaml").write_text(yaml.safe_dump(spec, sort_keys=False))
    fixture = d / "fixture"
    fixture.mkdir()
    (fixture / "app.py").write_text("def app():\n    return 1\n")
    hidden = d / "hidden"
    hidden.mkdir()
    (hidden / "test_bug.py").write_text("def test_bug():\n    assert app() == 1\n")
    return d


def test_digest_stable_and_content_sensitive(tmp_path):
    d = make_scenario_dir(tmp_path)
    a = scenario_digest(d)
    assert a == scenario_digest(d)
    (d / "fixture" / "app.py").write_text("changed")
    assert a != scenario_digest(d)


def test_load_scenario_parses(tmp_path):
    d = make_scenario_dir(tmp_path)
    loaded = load_scenario(d)
    assert loaded.ref == "sample-bug@1"
    assert loaded.metadata.name == "sample-bug"


def test_load_scenario_error_carries_path(tmp_path):
    d = tmp_path / "broken"
    d.mkdir()
    (d / "scenario.yaml").write_text("not: valid\n")
    with pytest.raises(Exception) as exc_info:
        load_scenario(d)
    assert str(d) in str(exc_info.value)


def test_registry_list_filters(tmp_path):
    root = tmp_path / "scenarios"
    root.mkdir()
    make_scenario_dir(
        root,
        name="sample-bug",
        overrides={
            "metadata.family": "debugging",
            "metadata.partition": "dev",
            "metadata.tags": ["python"],
        },
    )
    make_scenario_dir(
        root,
        name="no-change-scenario",
        overrides={
            "metadata.family": "no-change",
            "metadata.partition": "validation",
            "metadata.tags": ["rust"],
        },
    )
    # Non-scenario file at root — must be ignored by discovery.
    (root / "digests.lock").write_text("{}")

    registry = ScenarioRegistry(root)
    all_scenarios = registry.list()
    assert {s.spec.metadata.name for s in all_scenarios} == {
        "sample-bug",
        "no-change-scenario",
    }

    debugging = registry.list(family="debugging")
    assert {s.spec.metadata.name for s in debugging} == {"sample-bug"}

    validation = registry.list(partitions=["validation"])
    assert {s.spec.metadata.name for s in validation} == {"no-change-scenario"}

    tagged = registry.list(tags=["rust"])
    assert {s.spec.metadata.name for s in tagged} == {"no-change-scenario"}


def test_get_unknown_raises_with_names(tmp_path):
    root = tmp_path / "scenarios"
    root.mkdir()
    make_scenario_dir(root, name="sample-bug")

    registry = ScenarioRegistry(root)
    assert registry.get("sample-bug@1").ref == "sample-bug@1"  # known ref works

    with pytest.raises(KeyError) as exc_info:
        registry.get("does-not-exist@1")
    assert "sample-bug@1" in str(exc_info.value)


def test_get_returns_loaded_scenario(tmp_path):
    root = tmp_path / "scenarios"
    root.mkdir()
    make_scenario_dir(root, name="sample-bug")
    registry = ScenarioRegistry(root)
    loaded = registry.get("sample-bug@1")
    assert isinstance(loaded, LoadedScenario)
    assert loaded.ref == "sample-bug@1"


def test_get_bare_name_resolves_when_unambiguous(tmp_path):
    root = tmp_path / "scenarios"
    root.mkdir()
    make_scenario_dir(root, name="sample-bug")

    registry = ScenarioRegistry(root)
    loaded = registry.get("sample-bug")  # bare name, no version
    assert loaded.ref == "sample-bug@1"


def test_get_bare_name_ambiguous_raises(tmp_path):
    """Two directories whose scenarios share a metadata.name at different
    versions: a bare-name lookup can't pick one, so get() must raise rather
    than silently returning an arbitrary match."""
    root = tmp_path / "scenarios"
    root.mkdir()
    make_scenario_dir(
        root,
        name="sample-bug-v1",
        overrides={"metadata.name": "sample-bug", "metadata.version": 1},
    )
    make_scenario_dir(
        root,
        name="sample-bug-v2",
        overrides={"metadata.name": "sample-bug", "metadata.version": 2},
    )

    registry = ScenarioRegistry(root)
    with pytest.raises(KeyError) as exc_info:
        registry.get("sample-bug")
    message = str(exc_info.value).lower()
    assert "ambiguous" in message
    assert "sample-bug@1" in message
    assert "sample-bug@2" in message


def test_immutability_flags_unbumped_change(tmp_path):
    root = tmp_path / "scenarios"
    root.mkdir()
    make_scenario_dir(root, name="sample-bug")
    lockfile = tmp_path / "digests.lock"

    registry = ScenarioRegistry(root)
    update_lock(registry, lockfile)
    assert check_immutability(registry, lockfile) == []

    # Mutate fixture content without bumping metadata.version.
    (root / "sample-bug" / "fixture" / "app.py").write_text("def app():\n    return 2\n")
    registry = ScenarioRegistry(root)
    violations = check_immutability(registry, lockfile)
    assert len(violations) == 1
    assert "sample-bug@1" in violations[0]

    # Bump version -> no violations (new ref, old ref's digest untouched).
    scenario_yaml = root / "sample-bug" / "scenario.yaml"
    data = yaml.safe_load(scenario_yaml.read_text())
    data["metadata"]["version"] = 2
    scenario_yaml.write_text(yaml.safe_dump(data, sort_keys=False))

    registry = ScenarioRegistry(root)
    violations = check_immutability(registry, lockfile)
    assert violations == []


def test_update_lock_writes_json(tmp_path):
    root = tmp_path / "scenarios"
    root.mkdir()
    make_scenario_dir(root, name="sample-bug")
    lockfile = tmp_path / "digests.lock"

    registry = ScenarioRegistry(root)
    update_lock(registry, lockfile)

    data = json.loads(lockfile.read_text())
    assert set(data.keys()) == {"sample-bug@1"}
    assert data["sample-bug@1"] == scenario_digest(root / "sample-bug")
