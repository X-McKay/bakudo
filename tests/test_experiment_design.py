"""Experiment design tests (Task 8): seeds, scenario selection, matrix build,
and experiment ledger persistence.

Local ``MINIMAL``/``make_scenario_dir`` copy the ones in
tests/test_scenario_registry.py, following that file's own convention (no
``tests/__init__.py``, so cross-test-file imports are avoided).
"""

from __future__ import annotations

import copy

import pytest
import yaml

from bakudo.experiments.design import build_matrix, select_scenarios, trial_seed
from bakudo.experiments.models import (
    ExperimentMetadata,
    ExperimentSpec,
    ScenarioSelector,
)
from bakudo.ids import new_experiment_id
from bakudo.registry import InMemoryLedger
from bakudo.scenarios.registry import ScenarioRegistry

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


def make_scenario_dir(parent, name, overrides=None):
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


@pytest.fixture
def registry(tmp_path):
    root = tmp_path / "scenarios"
    root.mkdir()
    # Alphabetical order: csv-sum-offbyone, rate-limiter-fix,
    # rate-limiter-nochange, secret-holdout.
    make_scenario_dir(root, "csv-sum-offbyone", {
        "metadata.family": "debugging", "metadata.partition": "dev",
    })
    make_scenario_dir(root, "rate-limiter-fix", {
        "metadata.family": "debugging", "metadata.partition": "dev",
    })
    make_scenario_dir(root, "rate-limiter-nochange", {
        "metadata.family": "no-change", "metadata.partition": "dev",
        "metadata.twinOf": "rate-limiter-fix",
    })
    make_scenario_dir(root, "secret-holdout", {
        "metadata.family": "debugging", "metadata.partition": "holdout",
    })
    return ScenarioRegistry(root)


def spec_with(**overrides) -> ExperimentSpec:
    fields: dict = dict(
        metadata=ExperimentMetadata(name="exp-test"),
        subject="agent-spec",
        baseline="add-feature@1",
        candidates=[],
    )
    fields.update(overrides)
    return ExperimentSpec(**fields)


def test_seed_deterministic_and_shared():
    s = trial_seed("exp_A", "csv-sum-offbyone", 0)
    assert s == trial_seed("exp_A", "csv-sum-offbyone", 0)
    assert s != trial_seed("exp_A", "csv-sum-offbyone", 1)


def test_matrix_pairs_share_seed(registry):
    scns = select_scenarios(registry, spec_with())
    csv_scn = next(s for s in scns if s.spec.metadata.name == "csv-sum-offbyone")

    m = build_matrix(spec_with(candidates=["d@2"]), [csv_scn], "exp_A")
    by_key = {(t.scenario.spec.metadata.name, t.repetition, t.arm): t.seed for t in m}
    assert by_key[("csv-sum-offbyone", 0, "baseline")] == by_key[("csv-sum-offbyone", 0, "d@2")]


def test_holdout_excluded_by_default_and_stamped(registry):
    selector = ScenarioSelector(partitions=["dev", "validation", "holdout"])

    default_scns = select_scenarios(registry, spec_with(scenario_selector=selector))
    assert "secret-holdout" not in {s.spec.metadata.name for s in default_scns}

    holdout_scns = select_scenarios(
        registry, spec_with(use_holdout=True, scenario_selector=selector)
    )
    assert "secret-holdout" in {s.spec.metadata.name for s in holdout_scns}


def test_twin_closure(registry):
    # Selecting only the no-change family, capped at count=1, must still
    # pull in the fix twin — a different family, beyond the count cap.
    selector = ScenarioSelector(families=["no-change"], count=1)
    scns = select_scenarios(registry, spec_with(scenario_selector=selector))
    names = {s.spec.metadata.name for s in scns}
    assert names == {"rate-limiter-nochange", "rate-limiter-fix"}


def test_profile_mode_matrix_single_arm(registry):
    scns = select_scenarios(registry, spec_with())
    m = build_matrix(spec_with(candidates=[]), scns, "exp_A")
    assert m  # sanity: matrix isn't accidentally empty
    assert all(t.arm == "baseline" for t in m)
    assert len(m) == len(scns)  # one row per scenario, repetitions=1 default


def test_experiment_ledger_roundtrip():
    ledger = InMemoryLedger()
    experiment_id = new_experiment_id()
    spec = spec_with().to_dict()

    ledger.record_experiment(experiment_id, "exp-test", spec, "running")
    ledger.update_experiment_result(
        experiment_id, "completed", {"decision": "promote"}
    )
    got = ledger.get_experiment(experiment_id)

    assert got["id"] == experiment_id
    assert got["name"] == "exp-test"
    assert got["status"] == "completed"
    assert got["result"] == {"decision": "promote"}
    assert got["spec"]["metadata"]["name"] == "exp-test"
