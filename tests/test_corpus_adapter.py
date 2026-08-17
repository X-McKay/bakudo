"""The task-backed eval-corpus adapter.

``load_corpus_from_tasks`` maps a task source onto the existing
``EvalCase``/``run_corpus`` shape, and ``task_run_fn`` bridges a
``run_corpus``-style ``run_fn(objective) -> CaseRun`` to the trial substrate
(``bakudo.trials.runner.run_trial``).
"""

from __future__ import annotations

import pytest

from bakudo.curriculum.objective import Objective
from bakudo.evals.corpus import (
    CaseRun,
    load_corpus_from_tasks,
    run_corpus,
    task_run_fn,
)
from bakudo.paths import smoke_tasks_dir
from bakudo.runner.result import RunResult
from bakudo.tasks.source import DirectoryTaskSource
from bakudo.tasks.verifier_runner import VerificationResult
from bakudo.trials.runner import _StubPipelineResult


@pytest.fixture
def task_source() -> DirectoryTaskSource:
    return DirectoryTaskSource(smoke_tasks_dir())


def _always_passing_verifier_runner(workspace, command):
    return VerificationResult(passed=True, exit_code=0, output="")


# --------------------------------------------------------------------------
# load_corpus_from_tasks
# --------------------------------------------------------------------------


def test_maps_a_smoke_task_to_a_valid_eval_case(task_source):
    cases = load_corpus_from_tasks(families=["debugging"], source=task_source)
    assert cases
    names = {c.name for c in cases}
    assert "smoke-rate-limiter-fix@1" in names

    task = task_source.get("smoke-rate-limiter-fix@1")
    case = next(c for c in cases if c.name == "smoke-rate-limiter-fix@1")

    assert case.objective.type.value == task.spec.instruction.type
    assert case.objective.repo == "task://smoke-rate-limiter-fix@1"
    assert case.objective.title == task.spec.instruction.title
    assert case.objective.acceptance_criteria == task.spec.instruction.success_criteria
    case.objective.validate_against_schema()

    assert case.constraints.status == task.spec.constraints.expected_status
    assert case.constraints.allowed_change_paths == task.spec.constraints.allowed_change_paths
    assert case.constraints.max_changed_files == task.spec.constraints.max_changed_files
    assert case.constraints.forbids_denied_actions == task.spec.constraints.forbids_denied_actions


def test_family_and_partition_filters_are_honored(task_source):
    debugging_only = load_corpus_from_tasks(families=["debugging"], source=task_source)
    assert debugging_only
    assert all(
        task_source.get(c.name).spec.metadata.family.value == "debugging" for c in debugging_only
    )

    two_families = load_corpus_from_tasks(families=["debugging", "no-change"], source=task_source)
    assert len(two_families) > len(debugging_only)

    everything = load_corpus_from_tasks(source=task_source)
    assert len(everything) >= len(two_families)

    # Every smoke task ships in the "dev" partition, so a partition that
    # excludes it must come back empty rather than erroring.
    holdout_only = load_corpus_from_tasks(partitions=("holdout",), source=task_source)
    assert holdout_only == []


def test_case_names_are_unique_task_refs(task_source):
    cases = load_corpus_from_tasks(source=task_source)
    names = [c.name for c in cases]
    assert len(names) == len(set(names))
    assert all("@" in n for n in names)


# --------------------------------------------------------------------------
# run_corpus over task-backed cases
# --------------------------------------------------------------------------


def _stub_pipeline_factory(*, changed_files=(), diff="", denied=(), metrics=None):
    def build():
        def pipeline_fn(objective, agent_ref, budgets, network):
            return _StubPipelineResult(
                diff=diff,
                result=RunResult(
                    run_id="run_stub",
                    agent=agent_ref,
                    objective_id=objective.id,
                    status="success",
                    summary="stub run",
                    changed_files=list(changed_files),
                ),
                denied_commands=list(denied),
                metrics=metrics or {},
            )

        return pipeline_fn

    return build


def test_run_corpus_over_task_backed_cases_matches_existing_shape(task_source):
    cases = load_corpus_from_tasks(families=["debugging"], source=task_source)
    run_fn = task_run_fn(
        source=task_source,
        verifier_runner=_always_passing_verifier_runner,
        pipeline_factory=_stub_pipeline_factory(),
    )

    results = run_corpus("debugging-smoke", cases, run_fn, subject_id="debugger@1")
    by_suite = {r.suite_name: r for r in results}

    # Synthetic suites and aggregation math are pinned by tests/test_corpus.py.
    assert "role-specific" in by_suite
    assert "regression" in by_suite
    assert all(r.details["cases_total"] == 1 for r in results)
    assert all(r.details["corpus"] == "debugging-smoke" for r in results)


# --------------------------------------------------------------------------
# task_run_fn: TrialRecord -> CaseRun field mapping
# --------------------------------------------------------------------------


def test_task_run_fn_maps_pipeline_result_fields_onto_case_run(task_source):
    cases = load_corpus_from_tasks(families=["debugging"], source=task_source)
    case = next(c for c in cases if c.name == "smoke-rate-limiter-fix@1")

    run_fn = task_run_fn(
        source=task_source,
        verifier_runner=_always_passing_verifier_runner,
        pipeline_factory=_stub_pipeline_factory(
            changed_files=["limiter.py"],
            diff="--- a/limiter.py\n+++ b/limiter.py\n@@\n-x\n+y\n",
            denied=["rm -rf /"],
            metrics={"tokens": 123.0, "tool_calls": 4.0, "duration_s": 5.5},
        ),
    )

    case_run = run_fn(case.objective)

    assert isinstance(case_run, CaseRun)
    assert case_run.result.status.value == "success"
    assert case_run.result.changed_files == ["limiter.py"]
    assert "limiter.py" in case_run.diff
    assert case_run.denied_commands == [{"command": "rm -rf /"}]
    assert case_run.tokens_used == 123
    assert case_run.runtime_seconds == 5.5


def test_task_run_fn_raises_a_clear_error_for_an_unrelated_objective(task_source):
    run_fn = task_run_fn(
        source=task_source,
        verifier_runner=_always_passing_verifier_runner,
        pipeline_factory=_stub_pipeline_factory(),
    )
    bogus = Objective(type="qa", repo="/nowhere/at/all", title="not a task")
    with pytest.raises(KeyError):
        run_fn(bogus)
