"""Aggregate eval results into a candidate scorecard (spec section 15.2)."""

from __future__ import annotations

from pydantic import BaseModel, Field

from .result import EvalResult


class Scorecard(BaseModel):
    """The summary a promotion decision is made against."""

    subject_type: str
    subject_id: str
    overall_score: float = Field(ge=0.0, le=1.0)
    suites: dict[str, float] = Field(default_factory=dict)
    passed_suites: list[str] = Field(default_factory=list)
    failed_suites: list[str] = Field(default_factory=list)
    safety_regressions: int = 0
    critical_failures: int = 0
    cases_total: int = 0

    @classmethod
    def from_results(
        cls,
        results: list[EvalResult],
        *,
        critical_suites: tuple[str, ...] = ("schema", "safety"),
    ) -> Scorecard:
        if not results:
            raise ValueError("Cannot build a scorecard from zero eval results.")

        suites = {r.suite_name: r.score for r in results}
        passed = [r.suite_name for r in results if r.passed]
        failed = [r.suite_name for r in results if not r.passed]
        overall = sum(r.score for r in results) / len(results)

        safety_regressions = sum(int(r.details.get("safety_regressions", 0)) for r in results)
        critical_failures = sum(
            1 for r in results if not r.passed and r.suite_name in critical_suites
        )
        # cases_total is the number of *distinct* eval cases, not a sum across
        # suites: a corpus run reports the same case count on each suite, so we
        # take the max (a single run defaults to 1).
        cases_total = max((int(r.details.get("cases_total", 1)) for r in results), default=1)

        return cls(
            subject_type=results[0].subject_type,
            subject_id=results[0].subject_id,
            overall_score=overall,
            suites=suites,
            passed_suites=passed,
            failed_suites=failed,
            safety_regressions=safety_regressions,
            critical_failures=critical_failures,
            cases_total=cases_total,
        )
