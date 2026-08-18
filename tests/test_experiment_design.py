"""Experiment design tests (Task 8): seeds, task selection, matrix build,
and experiment ledger persistence.

Local ``MINIMAL``/``make_task_dir`` copy the ones in
tests/test_task_source.py, following that file's own convention (no
``tests/__init__.py``, so cross-test-file imports are avoided).
"""

from __future__ import annotations

import copy

import pytest
import yaml

from bakudo.experiments.design import build_matrix, select_tasks, trial_seed
from bakudo.experiments.models import (
    AgentSpecSubject,
    ExperimentMetadata,
    ExperimentSpec,
    TaskSelector,
)
from bakudo.ids import new_experiment_id
from bakudo.registry import InMemoryLedger
from bakudo.tasks.source import DirectoryTaskSource

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


def make_task_dir(parent, name, overrides=None):
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


@pytest.fixture
def registry(tmp_path):
    root = tmp_path / "tasks"
    root.mkdir()
    # Alphabetical order: csv-sum-offbyone, rate-limiter-fix,
    # rate-limiter-nochange, secret-holdout.
    make_task_dir(
        root,
        "csv-sum-offbyone",
        {
            "metadata.family": "debugging",
            "metadata.partition": "dev",
        },
    )
    make_task_dir(
        root,
        "rate-limiter-fix",
        {
            "metadata.family": "debugging",
            "metadata.partition": "dev",
        },
    )
    make_task_dir(
        root,
        "rate-limiter-nochange",
        {
            "metadata.family": "no-change",
            "metadata.partition": "dev",
            "metadata.pairedTask": "rate-limiter-fix",
        },
    )
    make_task_dir(
        root,
        "secret-holdout",
        {
            "metadata.family": "debugging",
            "metadata.partition": "holdout",
        },
    )
    return DirectoryTaskSource(root)


def spec_with(**overrides) -> ExperimentSpec:
    baseline = overrides.pop("baseline", "add-feature@1")
    candidates = overrides.pop("candidates", [])
    task_selector = overrides.pop("task_selector", TaskSelector())
    use_holdout = overrides.pop("use_holdout", False)
    fields: dict = dict(
        metadata=ExperimentMetadata(name="exp-test"),
        subject=AgentSpecSubject(
            baseline=baseline,
            candidates=candidates,
            task_selector=task_selector,
            use_holdout=use_holdout,
        ),
    )
    fields.update(overrides)
    return ExperimentSpec(**fields)


def test_seed_deterministic_and_shared():
    s = trial_seed("exp_A", "csv-sum-offbyone", 0)
    assert s == trial_seed("exp_A", "csv-sum-offbyone", 0)
    assert s != trial_seed("exp_A", "csv-sum-offbyone", 1)


def test_seed_fits_signed_bigint():
    # The ledger stores seeds in a Postgres bigint (signed 64-bit) column, so
    # every derived seed must stay within [0, 2**63 - 1]. Sweep enough cells
    # that unmasked top bits (set ~50% of the time) would certainly show up.
    for experiment_id in ("exp_A", "exp_B", "exp_C"):
        for task_name in ("csv-sum-offbyone", "no-change-a", "secret-holdout"):
            for repetition in range(20):
                seed = trial_seed(experiment_id, task_name, repetition)
                assert 0 <= seed <= 2**63 - 1


def test_matrix_pairs_share_seed(registry):
    selected_tasks = select_tasks(registry, spec_with())
    csv_task = next(s for s in selected_tasks if s.spec.metadata.name == "csv-sum-offbyone")

    m = build_matrix(spec_with(candidates=["d@2"]), [csv_task], "exp_A")
    by_key = {(t.task.spec.metadata.name, t.repetition, t.arm): t.seed for t in m}
    assert by_key[("csv-sum-offbyone", 0, "baseline")] == by_key[("csv-sum-offbyone", 0, "d@2")]


def test_holdout_excluded_by_default_and_stamped(registry):
    selector = TaskSelector(partitions=["dev", "validation", "holdout"])

    default_tasks = select_tasks(registry, spec_with(task_selector=selector))
    assert "secret-holdout" not in {s.spec.metadata.name for s in default_tasks}

    holdout_tasks = select_tasks(registry, spec_with(use_holdout=True, task_selector=selector))
    assert "secret-holdout" in {s.spec.metadata.name for s in holdout_tasks}


def test_paired_task_closure(registry):
    # Selecting only the no-change family, capped at count=1, must still
    # pull in the paired fix task — a different family, beyond the count cap.
    selector = TaskSelector(families=["no-change"], count=1)
    selected_tasks = select_tasks(registry, spec_with(task_selector=selector))
    names = {s.spec.metadata.name for s in selected_tasks}
    assert names == {"rate-limiter-nochange", "rate-limiter-fix"}


def test_profile_mode_matrix_single_arm(registry):
    selected_tasks = select_tasks(registry, spec_with())
    m = build_matrix(spec_with(candidates=[]), selected_tasks, "exp_A")
    assert m  # sanity: matrix isn't accidentally empty
    assert all(t.arm == "baseline" for t in m)
    assert len(m) == len(selected_tasks)  # one row per task, repetitions=1 default


def test_experiment_ledger_roundtrip():
    ledger = InMemoryLedger()
    experiment_id = new_experiment_id()
    spec = spec_with().to_dict()

    ledger.record_experiment(experiment_id, "exp-test", "agent-spec", spec, "running")
    ledger.update_experiment_result(experiment_id, "completed", {"decision": "promote"})
    got = ledger.get_experiment(experiment_id)

    assert got["id"] == experiment_id
    assert got["name"] == "exp-test"
    assert got["subject_kind"] == "agent-spec"
    assert got["status"] == "completed"
    assert got["result"] == {"decision": "promote"}
    assert got["spec"]["metadata"]["name"] == "exp-test"
