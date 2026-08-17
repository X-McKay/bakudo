import copy
import json

import pytest
import yaml

from bakudo.tasks.source import (
    DirectoryTaskSource,
    LoadedTask,
    check_immutability,
    load_task,
    task_bundle_digest,
    task_verifier_digest,
    update_lock,
)

# Mirrors tests/test_task_models.py::MINIMAL (Task 1). Kept as a local
# copy rather than a cross-module import so this file stands alone under
# pytest's rootdir-relative import mode (tests/ has no __init__.py).
MINIMAL = {
    "apiVersion": "bakudo.ai/v1alpha1",
    "kind": "TaskSpec",
    "metadata": {
        "name": "sample-bug",
        "version": 1,
        "family": "debugging",
        "difficulty": "easy",
        "tags": ["python"],
        "partition": "dev",
        "canary": "bakudo-canary-TESTGUID",
        "provenance": {
            "createdBy": "human",
            "createdAt": "2026-08-15",
            "sourceType": "hand-written",
            "eligibleForPromotion": True,
        },
    },
    "instruction": {
        "type": "qa",
        "title": "Fix the bug",
        "description": "There is a bug.",
        "successCriteria": ["tests pass"],
    },
    "environment": {"profile": "python-glibc", "network": "none"},
    "limits": {"wallSeconds": 600, "toolCalls": 30, "tokens": 20000},
    "verifier": {
        "failToPass": ["verifier/test_bug.py"],
        "passToPass": ["verifier/test_ok.py"],
        "command": "pytest {files} -q",
        "negativeControls": [],
    },
    "constraints": {
        "expectedStatus": "success",
        "allowedChangePaths": ["app.py"],
        "maxChangedFiles": 2,
        "forbidsDeniedActions": True,
        "verifierInputsImmutable": True,
    },
}


def make_task_dir(parent, name="sample-bug", overrides=None):
    """Write a task dir (MINIMAL + overrides) under parent/name."""
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
    (d / "task.yaml").write_text(yaml.safe_dump(spec, sort_keys=False))
    fixture = d / "fixture"
    fixture.mkdir()
    (fixture / "app.py").write_text("def app():\n    return 1\n")
    verifier = d / "verifier"
    verifier.mkdir()
    (verifier / "test_bug.py").write_text("def test_bug():\n    assert app() == 1\n")
    (verifier / "test_ok.py").write_text("def test_ok():\n    assert True\n")
    return d


def test_digest_stable_and_content_sensitive(tmp_path):
    d = make_task_dir(tmp_path)
    a = task_bundle_digest(d)
    assert a == task_bundle_digest(d)
    (d / "fixture" / "app.py").write_text("changed")
    assert a != task_bundle_digest(d)


def test_load_task_parses(tmp_path):
    d = make_task_dir(tmp_path)
    loaded = load_task(d)
    assert loaded.ref == "sample-bug@1"
    assert loaded.metadata.name == "sample-bug"


def test_load_task_error_carries_path(tmp_path):
    d = tmp_path / "broken"
    d.mkdir()
    (d / "task.yaml").write_text("not: valid\n")
    with pytest.raises(Exception) as exc_info:
        load_task(d)
    assert str(d) in str(exc_info.value)


def test_source_list_filters(tmp_path):
    root = tmp_path / "tasks"
    root.mkdir()
    make_task_dir(
        root,
        name="sample-bug",
        overrides={
            "metadata.family": "debugging",
            "metadata.partition": "dev",
            "metadata.tags": ["python"],
        },
    )
    make_task_dir(
        root,
        name="no-change-task",
        overrides={
            "metadata.family": "no-change",
            "metadata.partition": "validation",
            "metadata.tags": ["rust"],
        },
    )
    # Non-task file at root — must be ignored by discovery.
    (root / "digests.lock").write_text("{}")

    source = DirectoryTaskSource(root)
    all_tasks = source.list()
    assert {s.spec.metadata.name for s in all_tasks} == {
        "sample-bug",
        "no-change-task",
    }

    debugging = source.list(family="debugging")
    assert {s.spec.metadata.name for s in debugging} == {"sample-bug"}

    validation = source.list(partitions=["validation"])
    assert {s.spec.metadata.name for s in validation} == {"no-change-task"}

    tagged = source.list(tags=["rust"])
    assert {s.spec.metadata.name for s in tagged} == {"no-change-task"}


def test_get_unknown_raises_with_names(tmp_path):
    root = tmp_path / "tasks"
    root.mkdir()
    make_task_dir(root, name="sample-bug")

    source = DirectoryTaskSource(root)
    assert source.get("sample-bug@1").ref == "sample-bug@1"  # known ref works

    with pytest.raises(KeyError) as exc_info:
        source.get("does-not-exist@1")
    assert "sample-bug@1" in str(exc_info.value)


def test_get_returns_loaded_task(tmp_path):
    root = tmp_path / "tasks"
    root.mkdir()
    make_task_dir(root, name="sample-bug")
    source = DirectoryTaskSource(root)
    loaded = source.get("sample-bug@1")
    assert isinstance(loaded, LoadedTask)
    assert loaded.ref == "sample-bug@1"
    assert loaded.pin.source_uri == root.resolve().as_uri()
    assert loaded.pin.corpus_revision == "unversioned"
    assert loaded.pin.bundle_digest == task_bundle_digest(loaded.path)
    assert loaded.pin.verifier_digest == task_verifier_digest(loaded.path, loaded.spec)


def test_get_bare_name_resolves_when_unambiguous(tmp_path):
    root = tmp_path / "tasks"
    root.mkdir()
    make_task_dir(root, name="sample-bug")

    source = DirectoryTaskSource(root)
    loaded = source.get("sample-bug")  # bare name, no version
    assert loaded.ref == "sample-bug@1"


def test_get_bare_name_ambiguous_raises(tmp_path):
    """Two directories whose tasks share a metadata.name at different
    versions: a bare-name lookup can't pick one, so get() must raise rather
    than silently returning an arbitrary match."""
    root = tmp_path / "tasks"
    root.mkdir()
    make_task_dir(
        root,
        name="sample-bug-v1",
        overrides={"metadata.name": "sample-bug", "metadata.version": 1},
    )
    make_task_dir(
        root,
        name="sample-bug-v2",
        overrides={"metadata.name": "sample-bug", "metadata.version": 2},
    )

    source = DirectoryTaskSource(root)
    with pytest.raises(KeyError) as exc_info:
        source.get("sample-bug")
    message = str(exc_info.value).lower()
    assert "ambiguous" in message
    assert "sample-bug@1" in message
    assert "sample-bug@2" in message


def test_immutability_flags_unbumped_change(tmp_path):
    root = tmp_path / "tasks"
    root.mkdir()
    make_task_dir(root, name="sample-bug")
    lockfile = tmp_path / "digests.lock"

    source = DirectoryTaskSource(root)
    update_lock(source, lockfile)
    assert check_immutability(source, lockfile) == []

    # Mutate fixture content without bumping metadata.version.
    (root / "sample-bug" / "fixture" / "app.py").write_text("def app():\n    return 2\n")
    source = DirectoryTaskSource(root)
    violations = check_immutability(source, lockfile)
    assert len(violations) == 1
    assert "sample-bug@1" in violations[0]

    # Bump version -> no violations (new ref, old ref's digest untouched).
    task_yaml = root / "sample-bug" / "task.yaml"
    data = yaml.safe_load(task_yaml.read_text())
    data["metadata"]["version"] = 2
    task_yaml.write_text(yaml.safe_dump(data, sort_keys=False))

    source = DirectoryTaskSource(root)
    violations = check_immutability(source, lockfile)
    assert violations == []


def test_update_lock_writes_json(tmp_path):
    root = tmp_path / "tasks"
    root.mkdir()
    make_task_dir(root, name="sample-bug")
    lockfile = tmp_path / "digests.lock"

    source = DirectoryTaskSource(root)
    update_lock(source, lockfile)

    data = json.loads(lockfile.read_text())
    assert set(data.keys()) == {"sample-bug@1"}
    assert data["sample-bug@1"] == task_bundle_digest(root / "sample-bug")
