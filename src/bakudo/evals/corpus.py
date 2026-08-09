"""Eval corpora: score an agent (or candidate spec) over many cases (spec section 22).

A single run produces a thin scorecard (a handful of graders). To make
promotion meaningful (``minEvalCases``), a candidate is evaluated against a
*corpus* of cases. This module defines the corpus format, expectation grading,
and :func:`run_corpus`, which aggregates per-suite results across all cases.
"""

from __future__ import annotations

import fnmatch
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path

import yaml

from ..curriculum.objective import Objective
from ..runner.result import RunResult
from .checks import DEFAULT_SUITE, EvalContext, Grader
from .result import EvalResult


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
    """Load a corpus YAML into (suite_name, cases)."""
    doc = yaml.safe_load(Path(path).read_text())
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
