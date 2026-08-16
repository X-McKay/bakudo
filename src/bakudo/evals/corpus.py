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
from pathlib import Path
from typing import TYPE_CHECKING, Any

import yaml

from ..curriculum.objective import Objective
from ..runner.result import RunResult, RunStatus
from .checks import DEFAULT_SUITE, EvalContext, Grader
from .result import EvalResult

if TYPE_CHECKING:
    from ..scenarios.registry import LoadedScenario, ScenarioRegistry
    from ..scenarios.testrun import TestRunner
    from ..trials.runner import PipelineFn


@dataclass
class Expectations:
    """What a case asserts about a run's outcome."""

    status: str = "success"
    changes_paths: list[str] = field(default_factory=list)  # globs that must be touched
    forbids_denied_commands: bool = True
    max_changed_files: int | None = None


@dataclass
class EvalCase:
    name: str
    objective: Objective
    expect: Expectations = field(default_factory=Expectations)


@dataclass
class CaseRun:
    """The observed outcome of running one case (what the agent produced)."""

    result: RunResult
    diff: str = ""
    denied_commands: list[dict[str, str]] = field(default_factory=list)
    runtime_seconds: float = 0.0
    tokens_used: int = 0


def grade_expectations(case: EvalCase, run: CaseRun) -> tuple[bool, list[str]]:
    """Return (passed, reasons-for-failure) for a case's expectations."""
    reasons: list[str] = []
    exp = case.expect
    if run.result.status.value != exp.status:
        reasons.append(f"status {run.result.status.value} != expected {exp.status}")
    if exp.forbids_denied_commands and run.denied_commands:
        reasons.append(f"{len(run.denied_commands)} denied command(s)")
    if exp.max_changed_files is not None and len(run.result.changed_files) > exp.max_changed_files:
        reasons.append(
            f"{len(run.result.changed_files)} changed files > {exp.max_changed_files}"
        )
    for pattern in exp.changes_paths:
        if not any(fnmatch.fnmatch(p, pattern) for p in run.result.changed_files):
            reasons.append(f"no changed file matched '{pattern}'")
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


def load_corpus(path: str | Path) -> tuple[str, list[EvalCase]]:
    """Load a corpus YAML into (suite_name, cases).

    A missing file raises a clear, actionable error rather than a bare
    ``FileNotFoundError`` -- the two fictional/unrunnable example corpora
    that used to live under ``evals/corpora/`` are retired (real corpora now
    come from the scenario registry), so a caller hitting this is almost
    always looking for :func:`load_corpus_from_scenarios` instead of a
    genuinely out-of-tree legacy YAML corpus.
    """
    corpus_path = Path(path)
    if not corpus_path.is_file():
        raise FileNotFoundError(
            f"No corpus file at {corpus_path}. The bundled example corpora "
            "(evals/corpora/*.yaml) were retired in favor of the scenario "
            "registry -- use load_corpus_from_scenarios(...) "
            "(bakudo.evals.corpus) to build a corpus from evals/scenarios/ "
            "instead, or pass the path to a real, out-of-tree legacy corpus "
            "YAML."
        )
    doc = yaml.safe_load(corpus_path.read_text())
    suite_name = doc["name"]
    cases: list[EvalCase] = []
    for raw in doc.get("cases", []):
        exp = raw.get("expect", {})
        cases.append(
            EvalCase(
                name=raw["name"],
                objective=Objective.model_validate(raw["objective"]),
                expect=Expectations(
                    status=exp.get("status", "success"),
                    changes_paths=exp.get("changesPaths", []),
                    forbids_denied_commands=exp.get("forbidsDeniedCommands", True),
                    max_changed_files=exp.get("maxChangedFiles"),
                ),
            )
        )
    return suite_name, cases


# --------------------------------------------------------------------------
# Scenario-backed adapter (Task 7): the scenario registry (evals/scenarios/)
# is now the source of real corpora. load_corpus_from_scenarios() maps it
# onto the EvalCase shape above; scenario_run_fn() bridges the resulting
# EvalCase.objective back to a real run via bakudo.trials.runner.run_trial,
# so the exact same run_corpus() aggregation runs unchanged over either
# source.
# --------------------------------------------------------------------------

# EvalCase.objective built by load_corpus_from_scenarios() is a placeholder:
# objective_from_scenario() needs a repo path, but no workspace has been
# provisioned yet at corpus-build time (that only happens per-run, inside
# run_trial, with a fresh seed each time). The scenario's own (unprovisioned)
# directory stands in -- it must NEVER be treated as a runnable checkout (it
# holds scenario.yaml/hidden/reference alongside the fixture) -- purely as a
# stable, unique key. scenario_run_fn()'s returned run_fn only ever receives
# that placeholder Objective back (run_corpus's calling convention is
# run_fn(case.objective)), so it recovers the real LoadedScenario from this
# module-level lookup keyed by that same placeholder objective.repo, and lets
# run_trial do the real (correctly-scoped) provisioning.
_SCENARIO_BY_OBJECTIVE_REPO: dict[str, LoadedScenario] = {}


def load_corpus_from_scenarios(
    *,
    families: Sequence[str] | None = None,
    partitions: Sequence[str] = ("dev",),
    registry: ScenarioRegistry | None = None,
) -> list[EvalCase]:
    """Adapt the scenario registry into the ``EvalCase``/``run_corpus`` shape.

    Every scenario matching ``families`` (all families when ``None``) and
    ``partitions`` becomes one ``EvalCase``: ``name`` is the scenario's ref
    (``name@version``), ``objective`` comes from
    ``bakudo.trials.runner.objective_from_scenario`` (see the module note
    above for why its ``repo`` is a placeholder), and ``expect`` mirrors the
    scenario's own ``spec.expect``. ``registry`` defaults to a fresh
    ``ScenarioRegistry(scenarios_dir())`` (the exemplar corpus).
    """
    from ..paths import scenarios_dir
    from ..scenarios.registry import ScenarioRegistry
    from ..trials.runner import objective_from_scenario

    reg = registry if registry is not None else ScenarioRegistry(scenarios_dir())
    family_filters: list[str | None] = list(families) if families is not None else [None]

    by_ref: dict[str, Any] = {}
    for family in family_filters:
        for scenario in reg.list(family=family, partitions=partitions):
            by_ref.setdefault(scenario.ref, scenario)

    cases: list[EvalCase] = []
    for ref in sorted(by_ref):
        scenario = by_ref[ref]
        objective = objective_from_scenario(scenario, scenario.path)
        _SCENARIO_BY_OBJECTIVE_REPO[objective.repo] = scenario
        expect = scenario.spec.expect
        cases.append(
            EvalCase(
                name=scenario.ref,
                objective=objective,
                expect=Expectations(
                    status=expect.status,
                    changes_paths=list(expect.changes_paths),
                    forbids_denied_commands=expect.forbids_denied_commands,
                    max_changed_files=expect.max_changed_files,
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


def scenario_run_fn(
    *,
    test_runner: TestRunner,
    pipeline_factory: Callable[[], PipelineFn],
) -> Callable[[Objective], CaseRun]:
    """Bridge a ``run_corpus``-style ``run_fn(objective) -> CaseRun`` to
    :func:`bakudo.trials.runner.run_trial`.

    ``pipeline_factory() -> PipelineFn`` builds the pipeline for one case
    (e.g. ``lambda: build_pipeline_fn(spec, sandbox_fn=...)``); ``test_runner``
    is ``run_trial``'s hidden-test runner. The returned callable recovers the
    ``LoadedScenario`` a placeholder ``objective`` came from (see the
    module-level lookup above -- raises ``KeyError`` for an objective
    ``load_corpus_from_scenarios`` never built), runs one trial (a fresh,
    ephemeral ``InMemoryLedger`` records it -- callers that need the
    immutable trial history persisted should use the trial/experiment
    substrate directly instead of this eval-corpus bridge), and maps the
    ``TrialRecord`` -> ``CaseRun``: ``result``/``diff``/``denied_commands``
    come from the pipeline result itself (the trusted, unabridged source --
    a ``TrialRecord`` only durably keeps counts/summaries of these, not the
    full diff text or file list), while ``runtime_seconds``/``tokens_used``
    come from the recorded trial's ``metrics`` (``duration_s``/``tokens``).
    """
    from ..registry import InMemoryLedger
    from ..trials.runner import run_trial

    ledger = InMemoryLedger()

    def run(objective: Objective) -> CaseRun:
        scenario = _SCENARIO_BY_OBJECTIVE_REPO.get(objective.repo)
        if scenario is None:
            raise KeyError(
                f"No scenario registered for objective.repo={objective.repo!r}. "
                "scenario_run_fn() only runs objectives built by "
                "load_corpus_from_scenarios(); build the corpus with that "
                "function first."
            )

        pipeline_fn = pipeline_factory()
        captured: dict[str, Any] = {}

        def capturing_pipeline_fn(obj, agent_ref, budgets, network):
            pr = pipeline_fn(obj, agent_ref, budgets, network)
            captured["pr"] = pr
            return pr

        record = run_trial(
            scenario,
            "corpus-eval@0",
            0,
            pipeline_fn=capturing_pipeline_fn,
            test_runner=test_runner,
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
