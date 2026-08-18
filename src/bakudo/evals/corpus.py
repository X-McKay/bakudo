"""Eval corpora: score an agent (or candidate spec) over many cases (spec section 22).

A single run produces a thin scorecard (a handful of graders). To make
promotion meaningful (``minEvalCases``), a candidate is evaluated against a
*corpus* of cases. This module defines the corpus format, expectation grading,
and :func:`run_corpus`, which aggregates per-suite results across all cases.
"""

from __future__ import annotations

import fnmatch
from collections import defaultdict
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from ..curriculum.objective import Constraints, Objective, ObjectiveType
from ..runner.result import RunResult, RunStatus
from .checks import DEFAULT_SUITE, EvalContext, Grader
from .result import EvalResult

if TYPE_CHECKING:
    from ..tasks.source import LoadedTask, TaskSource
    from ..tasks.verifier_runner import VerifierRunner
    from ..trials.runner import PipelineFn


@dataclass
class OutcomeConstraints:
    """What a case asserts about a run's outcome."""

    status: str = "success"
    allowed_change_paths: list[str] = field(default_factory=list)  # permitted path globs
    forbids_denied_actions: bool = True
    max_changed_files: int | None = None


@dataclass
class EvalCase:
    name: str
    objective: Objective
    constraints: OutcomeConstraints = field(default_factory=OutcomeConstraints)


@dataclass
class CaseRun:
    """The observed outcome of running one case (what the agent produced)."""

    result: RunResult
    diff: str = ""
    denied_commands: list[dict[str, str]] = field(default_factory=list)
    runtime_seconds: float = 0.0
    tokens_used: int = 0


def grade_expectations(case: EvalCase, run: CaseRun) -> tuple[bool, list[str]]:
    """Return whether an observed outcome satisfies the case constraints."""
    reasons: list[str] = []
    exp = case.constraints
    if run.result.status.value != exp.status:
        reasons.append(f"status {run.result.status.value} != expected {exp.status}")
    if exp.forbids_denied_actions and run.denied_commands:
        reasons.append(f"{len(run.denied_commands)} denied command(s)")
    if exp.max_changed_files is not None and len(run.result.changed_files) > exp.max_changed_files:
        reasons.append(f"{len(run.result.changed_files)} changed files > {exp.max_changed_files}")
    unexpected = [
        path
        for path in run.result.changed_files
        if not any(fnmatch.fnmatch(path, pattern) for pattern in exp.allowed_change_paths)
    ]
    if unexpected:
        allowed = ", ".join(exp.allowed_change_paths) or "<none>"
        reasons.append(
            f"changed files outside allowed paths: {', '.join(unexpected)}; allowed: {allowed}"
        )
    return (not reasons), reasons


def run_corpus(
    suite_name: str,
    cases: list[EvalCase],
    run_fn,
    *,
    subject_id: str,
    subject_type: str = "agent_spec_version",
    graders: list[Grader] = DEFAULT_SUITE,
) -> list[EvalResult]:
    """Run every case and aggregate per-suite results across the corpus.

    ``run_fn(objective) -> CaseRun`` executes one case (typically by spawning a
    sandboxed run). Each grader's per-case results are averaged into one
    aggregate :class:`EvalResult`; expectation grading becomes a synthetic
    ``role-specific`` suite, and a synthetic ``regression`` suite (spec §15.3
    — required by the default promotion policy) passes only when every case is
    fully clean (all graders AND expectations). ``cases_total`` is the corpus
    size.
    """
    if not cases:
        raise ValueError("Cannot run an empty corpus.")

    per_suite: dict[str, list[EvalResult]] = defaultdict(list)
    expectation_passes = 0
    clean_cases = 0

    for case in cases:
        run: CaseRun = run_fn(case.objective)
        ctx = EvalContext(
            result=run.result,
            objective=case.objective,
            diff=run.diff,
            denied_commands=run.denied_commands,
            runtime_seconds=run.runtime_seconds,
            tokens_used=run.tokens_used,
        )
        case_results = [grader(ctx) for grader in graders]
        for res in case_results:
            per_suite[res.suite_name].append(res)
        passed, _ = grade_expectations(case, run)
        expectation_passes += int(passed)
        clean_cases += int(passed and all(r.passed for r in case_results))

    total = len(cases)
    aggregated: list[EvalResult] = []
    for name, results in per_suite.items():
        cases_passed = sum(1 for r in results if r.passed)
        score = sum(r.score for r in results) / len(results)
        safety_regressions = sum(int(r.details.get("safety_regressions", 0)) for r in results)
        aggregated.append(
            EvalResult(
                subject_type=subject_type,
                subject_id=subject_id,
                suite_name=name,
                score=score,
                passed=cases_passed == total,
                details={
                    "cases_total": total,
                    "cases_passed": cases_passed,
                    "safety_regressions": safety_regressions,
                    "corpus": suite_name,
                },
            )
        )

    aggregated.append(
        EvalResult(
            subject_type=subject_type,
            subject_id=subject_id,
            suite_name="role-specific",
            score=expectation_passes / total,
            passed=expectation_passes == total,
            details={
                "cases_total": total,
                "cases_passed": expectation_passes,
                "corpus": suite_name,
            },
        )
    )
    aggregated.append(
        EvalResult(
            subject_type=subject_type,
            subject_id=subject_id,
            suite_name="regression",
            score=clean_cases / total,
            passed=clean_cases == total,
            details={
                "cases_total": total,
                "cases_passed": clean_cases,
                "corpus": suite_name,
            },
        )
    )
    for r in aggregated:
        r.validate_against_schema()
    return aggregated


_TASK_REF_PREFIX = "task://"


def load_corpus_from_tasks(
    *,
    families: Sequence[str] | None = None,
    partitions: Sequence[str] = ("dev",),
    source: TaskSource | None = None,
) -> list[EvalCase]:
    """Adapt a task source into the ``EvalCase``/``run_corpus`` shape.

    Every matching task becomes one ``EvalCase``. Its objective carries a
    stable ``task://name@version`` identity instead of a filesystem path;
    :func:`task_run_fn` resolves that identity through its explicit source.
    """
    from ..tasks.source import default_task_source

    resolved_source = source if source is not None else default_task_source()
    family_filters: list[str | None] = list(families) if families is not None else [None]

    by_ref: dict[str, LoadedTask] = {}
    for family in family_filters:
        for task in resolved_source.list(family=family, partitions=partitions):
            by_ref.setdefault(task.ref, task)

    cases: list[EvalCase] = []
    for ref in sorted(by_ref):
        task = by_ref[ref]
        instruction = task.spec.instruction
        constraints = task.spec.constraints
        cases.append(
            EvalCase(
                name=task.ref,
                objective=Objective(
                    type=ObjectiveType(instruction.type),
                    repo=f"{_TASK_REF_PREFIX}{task.ref}",
                    title=instruction.title,
                    description=instruction.description,
                    acceptance_criteria=list(instruction.success_criteria),
                    constraints=Constraints(
                        max_files_changed=constraints.max_changed_files
                    ),
                ),
                constraints=OutcomeConstraints(
                    status=constraints.expected_status,
                    allowed_change_paths=list(constraints.allowed_change_paths),
                    forbids_denied_actions=constraints.forbids_denied_actions,
                    max_changed_files=constraints.max_changed_files,
                ),
            )
        )
    return cases


def _coerce_run_result(pipeline_result_value: Any, trial_record: Any) -> RunResult:
    """Best-effort coercion of a ``pipeline_fn`` return's ``.result`` into a
    real :class:`RunResult`, for grading.

    A real caller's ``pipeline_fn`` (``build_pipeline_fn``'s adapter) already
    returns a proper ``RunResult`` here, which passes through unchanged. A
    bare test double (some of ``run_trial``'s own stubs only set
    ``status``/``changed_files``) is topped up from the recorded
    ``TrialRecord`` so grading never crashes on a missing field.
    """
    if isinstance(pipeline_result_value, RunResult):
        return pipeline_result_value

    data: dict[str, Any] | None = None
    if isinstance(pipeline_result_value, dict):
        data = pipeline_result_value
    elif hasattr(pipeline_result_value, "model_dump"):
        data = pipeline_result_value.model_dump()
    if data is not None:
        try:
            return RunResult.model_validate(data)
        except Exception:  # noqa: BLE001 - fall through to the synthesized shape below
            pass

    status_value = getattr(pipeline_result_value, "status", None)
    status_str = getattr(status_value, "value", status_value) or trial_record.evaluation.get(
        "actual_status"
    )
    try:
        status = RunStatus(status_str)
    except ValueError:
        status = RunStatus.failed
    return RunResult(
        run_id=trial_record.run_id or trial_record.id,
        agent=trial_record.agent_ref,
        objective_id=trial_record.objective_id or "",
        status=status,
        summary=str(trial_record.evaluation.get("detail", "")),
        changed_files=list(getattr(pipeline_result_value, "changed_files", None) or []),
    )


def task_run_fn(
    *,
    source: TaskSource,
    verifier_runner: VerifierRunner,
    pipeline_factory: Callable[[], PipelineFn],
) -> Callable[[Objective], CaseRun]:
    """Bridge a ``run_corpus``-style ``run_fn(objective) -> CaseRun`` to
    :func:`bakudo.trials.runner.run_trial`.

    ``pipeline_factory() -> PipelineFn`` builds the pipeline for one case and
    ``verifier_runner`` is ``run_trial``'s verifier boundary. The returned
    callable resolves the objective's task identity through ``source``, runs
    one trial using a fresh ephemeral ledger, and maps the
    ``TrialRecord`` -> ``CaseRun``: ``result``/``diff``/``denied_commands``
    come from the pipeline result itself (the trusted, unabridged source --
    a ``TrialRecord`` only durably keeps counts/summaries of these, not the
    full diff text or file list), while ``runtime_seconds``/``tokens_used``
    come from the recorded trial's ``metrics`` (``duration_s``/``tokens``).
    """
    from ..registry import InMemoryLedger
    from ..trials.runner import run_trial

    def run(objective: Objective) -> CaseRun:
        if not objective.repo.startswith(_TASK_REF_PREFIX):
            raise KeyError(
                f"Expected objective.repo to start with {_TASK_REF_PREFIX!r}; "
                f"got {objective.repo!r}."
            )
        task = source.get(objective.repo.removeprefix(_TASK_REF_PREFIX))
        ledger = InMemoryLedger()

        pipeline_fn = pipeline_factory()
        captured: dict[str, Any] = {}

        def capturing_pipeline_fn(obj, agent_ref, budgets, network):
            pr = pipeline_fn(obj, agent_ref, budgets, network)
            captured["pr"] = pr
            return pr

        record = run_trial(
            task,
            "corpus-eval@0",
            0,
            pipeline_fn=capturing_pipeline_fn,
            verifier_runner=verifier_runner,
            ledger=ledger,
        )

        pr = captured.get("pr")
        result = _coerce_run_result(getattr(pr, "result", None), record)
        diff = getattr(pr, "diff", "") or ""
        denied_commands = [{"command": c} for c in (getattr(pr, "denied_commands", None) or [])]
        metrics = record.metrics
        return CaseRun(
            result=result,
            diff=diff,
            denied_commands=denied_commands,
            runtime_seconds=float(metrics.get("duration_s", 0.0)),
            tokens_used=int(metrics.get("tokens", 0.0)),
        )

    return run
