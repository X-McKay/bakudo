"""Automatic curriculum generation from repository signals (spec sections 16.1, 10).

This is the Voyager "automatic curriculum": turn observable repo state — issues,
failing CI, TODOs, coverage gaps, dependency advisories — into scored, candidate
:class:`Objective` s. The signal *collection* (GitHub/CI/coverage I/O) is a
Temporal activity; the *mapping* logic here is pure and unit-tested.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from .. import ids
from .objective import Objective, ObjectiveType, Priority, rank


def _observer_id(repo: str, type_: ObjectiveType, source_key: str) -> str:
    """Deterministic objective id from (repo, type, source key) — the same
    repo signal yields the SAME id every observer cycle (MEM-6), so the meta
    workflow can dedupe by id instead of re-dispatching duplicates."""
    return ids.deterministic_objective_id(f"{repo}\x1f{type_.value}\x1f{source_key}")


@dataclass
class Issue:
    number: int
    title: str
    body: str = ""
    labels: list[str] = field(default_factory=list)


@dataclass
class FailingTest:
    name: str
    message: str = ""


@dataclass
class Todo:
    path: str
    text: str


@dataclass
class CoverageGap:
    path: str
    covered_pct: float  # 0..1


@dataclass
class Advisory:
    package: str
    severity: str  # low | moderate | high | critical


@dataclass
class RepoSignals:
    """A snapshot of a repository's actionable state (spec section 16.1)."""

    repo: str
    issues: list[Issue] = field(default_factory=list)
    failing_tests: list[FailingTest] = field(default_factory=list)
    todos: list[Todo] = field(default_factory=list)
    coverage_gaps: list[CoverageGap] = field(default_factory=list)
    advisories: list[Advisory] = field(default_factory=list)


_SEVERITY_RISK = {"low": 0.2, "moderate": 0.45, "high": 0.7, "critical": 0.95}


def _label_value(labels: list[str]) -> float:
    lowered = {label.lower() for label in labels}
    if {"priority:high", "p0", "critical"} & lowered:
        return 0.9
    if {"priority:medium", "p1"} & lowered:
        return 0.6
    return 0.4


def _issue_objective(repo: str, issue: Issue) -> Objective:
    is_bug = any(label.lower() in {"bug", "defect"} for label in issue.labels)
    return Objective(
        id=_observer_id(repo, ObjectiveType.add_feature, f"issue:{issue.number}"),
        type=ObjectiveType.add_feature,
        repo=repo,
        title=issue.title,
        description=issue.body,
        suggested_agents=["explore", "add-feature", "qa"],
        priority=Priority(
            value=_label_value(issue.labels),
            urgency=0.7 if is_bug else 0.4,
            learning_value=0.3,
            confidence=0.5,
        ),
    )


def _failing_test_objective(repo: str, test: FailingTest) -> Objective:
    return Objective(
        id=_observer_id(repo, ObjectiveType.qa, f"test:{test.name}"),
        type=ObjectiveType.qa,
        repo=repo,
        title=f"Fix failing test: {test.name}",
        description=test.message,
        acceptance_criteria=[f"{test.name} passes", "No new test failures introduced"],
        suggested_agents=["explore", "add-feature", "qa"],
        priority=Priority(value=0.7, urgency=0.9, confidence=0.6, learning_value=0.2),
    )


def _todo_objective(repo: str, todo: Todo) -> Objective:
    return Objective(
        id=_observer_id(
            repo, ObjectiveType.maintenance, f"todo:{todo.path}:{todo.text}"
        ),
        type=ObjectiveType.maintenance,
        repo=repo,
        title=f"Resolve TODO in {todo.path}",
        description=todo.text,
        suggested_agents=["explore", "add-feature"],
        priority=Priority(value=0.35, urgency=0.2, learning_value=0.4, confidence=0.5),
    )


def _coverage_objective(repo: str, gap: CoverageGap) -> Objective:
    deficit = max(0.0, 1.0 - gap.covered_pct)
    return Objective(
        id=_observer_id(repo, ObjectiveType.eval_author, f"coverage:{gap.path}"),
        type=ObjectiveType.eval_author,
        repo=repo,
        title=f"Raise test coverage for {gap.path}",
        acceptance_criteria=[f"Add tests covering {gap.path}", "Coverage increases"],
        suggested_agents=["explore", "add-feature", "qa"],
        priority=Priority(value=0.4 + 0.3 * deficit, urgency=0.3, learning_value=0.5),
    )


def _advisory_objective(repo: str, advisory: Advisory) -> Objective:
    risk = _SEVERITY_RISK.get(advisory.severity.lower(), 0.5)
    return Objective(
        id=_observer_id(
            repo, ObjectiveType.maintenance, f"advisory:{advisory.package}"
        ),
        type=ObjectiveType.maintenance,
        repo=repo,
        title=f"Patch advisory in {advisory.package} ({advisory.severity})",
        acceptance_criteria=["Update the affected dependency", "Tests still pass"],
        suggested_agents=["add-feature", "qa"],
        priority=Priority(value=0.6, urgency=risk, risk=risk, confidence=0.6),
    )


def generate_objectives(signals: RepoSignals) -> list[Objective]:
    """Map a repo snapshot to deduplicated, priority-ranked objectives."""
    objectives: list[Objective] = []
    objectives += [_issue_objective(signals.repo, i) for i in signals.issues]
    objectives += [_failing_test_objective(signals.repo, t) for t in signals.failing_tests]
    objectives += [_todo_objective(signals.repo, t) for t in signals.todos]
    objectives += [_coverage_objective(signals.repo, g) for g in signals.coverage_gaps]
    objectives += [_advisory_objective(signals.repo, a) for a in signals.advisories]

    # Dedupe by (type, title) keeping the highest-value instance.
    best: dict[tuple[str, str], Objective] = {}
    for obj in objectives:
        key = (obj.type.value, obj.title)
        incumbent = best.get(key)
        if incumbent is None or obj.priority.compute() > incumbent.priority.compute():
            best[key] = obj

    return rank(list(best.values()))
