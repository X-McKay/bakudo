"""A/B comparison of two agent versions over a corpus (§6.6 of the roadmap).

The measurement layer behind promotion: run baseline and candidate over the
same cases with R repetitions and report **pass-rate lift in percentage
points** plus paired per-case cost deltas (tokens, runtime). Methodology
rules borrowed deliberately:

* In a comparative run, a low score is an *observation*, not a failure —
  callers decide what lift justifies promotion; nothing here throws on a bad
  candidate.
* Missing observations are surfaced as typed diagnostics, never silently
  dropped: a case runner that raises produces a ``harness-error`` diagnostic
  and counts as not-passed for that (case, repetition).
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from statistics import mean

from ..agent_spec import AgentSpec
from .corpus import CaseRun, EvalCase, grade_expectations


@dataclass
class Observation:
    """One (case, repetition, side) execution."""

    case: str
    repetition: int
    side: str  # baseline | candidate
    passed: bool
    tokens_used: int
    runtime_seconds: float


@dataclass
class Diagnostic:
    kind: str  # harness-error
    case: str
    repetition: int
    side: str
    detail: str


@dataclass
class CaseComparison:
    case: str
    baseline_passes: int
    candidate_passes: int
    repetitions: int

    @property
    def lift_pp(self) -> float:
        return 100.0 * (self.candidate_passes - self.baseline_passes) / self.repetitions


@dataclass
class ABReport:
    baseline_ref: str
    candidate_ref: str
    repetitions: int
    cases_total: int
    baseline_pass_rate: float
    candidate_pass_rate: float
    pass_rate_lift_pp: float
    tokens_delta: float          # candidate mean - baseline mean, paired
    runtime_delta_seconds: float
    per_case: list[CaseComparison] = field(default_factory=list)
    diagnostics: list[Diagnostic] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "baseline": self.baseline_ref,
            "candidate": self.candidate_ref,
            "repetitions": self.repetitions,
            "cases_total": self.cases_total,
            "baseline_pass_rate": self.baseline_pass_rate,
            "candidate_pass_rate": self.candidate_pass_rate,
            "pass_rate_lift_pp": self.pass_rate_lift_pp,
            "tokens_delta": self.tokens_delta,
            "runtime_delta_seconds": self.runtime_delta_seconds,
            "per_case": [
                {
                    "case": c.case,
                    "baseline_passes": c.baseline_passes,
                    "candidate_passes": c.candidate_passes,
                    "repetitions": c.repetitions,
                    "lift_pp": c.lift_pp,
                }
                for c in self.per_case
            ],
            "diagnostics": [
                {
                    "kind": d.kind, "case": d.case, "repetition": d.repetition,
                    "side": d.side, "detail": d.detail,
                }
                for d in self.diagnostics
            ],
        }


RunFn = Callable[[AgentSpec, object], CaseRun]


def ab_compare(
    baseline: AgentSpec,
    candidate: AgentSpec,
    cases: list[EvalCase],
    run_fn: RunFn,
    *,
    repetitions: int = 3,
) -> ABReport:
    """Run both specs over every case R times and report paired statistics.

    ``run_fn(spec, objective) -> CaseRun`` — the same contract as
    :func:`~bakudo.evals.evolution.evolve_agent`.
    """
    if not cases:
        raise ValueError("Cannot compare over an empty corpus.")
    if repetitions < 1:
        raise ValueError("repetitions must be >= 1")

    observations: list[Observation] = []
    diagnostics: list[Diagnostic] = []

    for repetition in range(repetitions):
        for case in cases:
            for side, spec in (("baseline", baseline), ("candidate", candidate)):
                try:
                    run = run_fn(spec, case.objective)
                    passed, _ = grade_expectations(case, run)
                    observations.append(
                        Observation(
                            case=case.name,
                            repetition=repetition,
                            side=side,
                            passed=passed,
                            tokens_used=run.tokens_used,
                            runtime_seconds=run.runtime_seconds,
                        )
                    )
                except Exception as exc:  # noqa: BLE001 - typed diagnostic, not a crash
                    diagnostics.append(
                        Diagnostic(
                            kind="harness-error",
                            case=case.name,
                            repetition=repetition,
                            side=side,
                            detail=f"{type(exc).__name__}: {exc}"[:300],
                        )
                    )
                    observations.append(
                        Observation(
                            case=case.name,
                            repetition=repetition,
                            side=side,
                            passed=False,
                            tokens_used=0,
                            runtime_seconds=0.0,
                        )
                    )

    def side_obs(side: str) -> list[Observation]:
        return [o for o in observations if o.side == side]

    baseline_obs, candidate_obs = side_obs("baseline"), side_obs("candidate")
    baseline_rate = mean(o.passed for o in baseline_obs)
    candidate_rate = mean(o.passed for o in candidate_obs)

    per_case = [
        CaseComparison(
            case=case.name,
            baseline_passes=sum(
                o.passed for o in baseline_obs if o.case == case.name
            ),
            candidate_passes=sum(
                o.passed for o in candidate_obs if o.case == case.name
            ),
            repetitions=repetitions,
        )
        for case in cases
    ]

    return ABReport(
        baseline_ref=baseline.ref,
        candidate_ref=candidate.ref,
        repetitions=repetitions,
        cases_total=len(cases),
        baseline_pass_rate=baseline_rate,
        candidate_pass_rate=candidate_rate,
        pass_rate_lift_pp=100.0 * (candidate_rate - baseline_rate),
        tokens_delta=(
            mean(o.tokens_used for o in candidate_obs)
            - mean(o.tokens_used for o in baseline_obs)
        ),
        runtime_delta_seconds=(
            mean(o.runtime_seconds for o in candidate_obs)
            - mean(o.runtime_seconds for o in baseline_obs)
        ),
        per_case=per_case,
        diagnostics=diagnostics,
    )
