"""Critic eval: an LLM reviewer scores a run's diff/reasoning (spec section 22.1).

The grader is *judge-injectable*: tests pass a deterministic fake judge; in
production a vLLM-backed judge is built with :func:`llm_judge`. When no judge is
available the critic abstains (passes with a note) rather than blocking.

The production entry point is :func:`gated_critic_eval` — a free, deterministic
**triage** decides obvious passes and obvious failures without spending a model
call; only the ambiguous middle reaches the judge. It joins the run suites when
``BAKUDO_CRITIC_MODEL`` is configured (see :func:`default_judge`), and that
should only happen after ``bakudo critic-calibrate`` shows the judge agreeing
with human labels (>= 0.9 by default) on the calibration corpus.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

from .checks import EvalContext
from .result import EvalResult

# A judge maps a review prompt to a verdict dict: {score: 0..1, passed: bool,
# issues: [str]}.
Judge = Callable[[str], dict]

# Triage verdicts (the cheap gate in front of the expensive judge).
OBVIOUS_PASS = "obvious-pass"
OBVIOUS_FAIL = "obvious-fail"
AMBIGUOUS = "ambiguous"

# Below these, a green run is too small/simple to be worth a review call.
_SMALL_DIFF_BYTES = 2000
_SMALL_CHANGE_FILES = 3


def _review_prompt(ctx: EvalContext) -> str:
    return (
        "You are a senior code reviewer. Review the change below against the "
        "objective and report serious correctness risks, design flaws, missing "
        "tests, and security concerns.\n\n"
        f"Objective: {ctx.objective.title}\n"
        f"Acceptance criteria: {ctx.objective.acceptance_criteria}\n"
        f"Summary: {ctx.result.summary}\n"
        f"Changed files: {ctx.result.changed_files}\n\n"
        f"Diff:\n{ctx.diff[:12000]}\n\n"
        'Respond with JSON: {"score": <0..1>, "passed": <bool>, "issues": [<str>...]}.'
    )


def triage(ctx: EvalContext) -> tuple[str, str]:
    """Free, deterministic pre-judgement: (verdict, reason).

    Only ``ambiguous`` runs reach the judge — the prime-agent lesson (a cheap
    gate in front of an expensive reviewer) implemented with a heuristic
    instead of a small model, so it costs nothing and never drifts.
    """
    result = ctx.result
    if result.status.value != "success":
        return OBVIOUS_FAIL, f"run status is {result.status.value}"
    if result.blocked_reasons:
        return OBVIOUS_FAIL, f"blocked reasons present: {result.blocked_reasons[:3]}"
    failed = [t for t in result.tests_run if t.status in ("failed", "error")]
    if failed:
        return OBVIOUS_FAIL, f"{len(failed)} failing test(s)"
    if ctx.denied_commands:
        return AMBIGUOUS, "denied commands during the run"
    passed_tests = [t for t in result.tests_run if t.status == "passed"]
    if (
        passed_tests
        and len(result.changed_files) <= _SMALL_CHANGE_FILES
        and len(ctx.diff) <= _SMALL_DIFF_BYTES
    ):
        return OBVIOUS_PASS, "green tests, small contained diff"
    return AMBIGUOUS, "large or untested change needs review"


def gated_critic_eval(ctx: EvalContext, judge: Judge) -> EvalResult:
    """The critic level with the triage gate in front of the judge.

    Obvious passes and failures are decided for free; only ambiguous runs
    spend a judge call. The triage verdict is always recorded in details so
    calibration can measure the gate and the judge separately.
    """
    verdict, reason = triage(ctx)
    if verdict == OBVIOUS_PASS:
        return EvalResult(
            subject_type="run",
            subject_id=ctx.result.run_id,
            suite_name="critic",
            score=1.0,
            passed=True,
            details={"triage": verdict, "judged": False, "reason": reason},
        )
    if verdict == OBVIOUS_FAIL:
        return EvalResult(
            subject_type="run",
            subject_id=ctx.result.run_id,
            suite_name="critic",
            score=0.0,
            passed=False,
            details={"triage": verdict, "judged": False, "reason": reason},
        )
    judged = critic_eval(ctx, judge)
    judged.details.update({"triage": verdict, "judged": True})
    return judged


def default_judge() -> Judge | None:
    """The judge run suites use, or None when the critic is not configured.

    Requires ``BAKUDO_CRITIC_MODEL`` and a live gateway (never in offline
    mode). Configure it only after ``bakudo critic-calibrate`` shows adequate
    agreement with the human-labelled calibration corpus.
    """
    from ..config import Settings

    settings = Settings.from_env()
    if settings.offline or not settings.critic_model:
        return None
    return llm_judge(settings.critic_model)


def critic_eval(ctx: EvalContext, judge: Judge | None = None) -> EvalResult:
    """Grade a run with a critic judge, abstaining if none is configured."""
    if judge is None:
        return EvalResult(
            subject_type="run",
            subject_id=ctx.result.run_id,
            suite_name="critic",
            score=1.0,
            passed=True,
            details={"abstained": True, "reason": "no critic judge configured"},
        )

    verdict = judge(_review_prompt(ctx))
    score = float(verdict.get("score", 0.0))
    issues = verdict.get("issues", []) or []
    passed = bool(verdict.get("passed", score >= 0.6 and not issues))
    return EvalResult(
        subject_type="run",
        subject_id=ctx.result.run_id,
        suite_name="critic",
        score=max(0.0, min(1.0, score)),
        passed=passed,
        details={"issues": issues, "issue_count": len(issues)},
    )


def llm_judge(model_id: str, base_url_ref: str | None = None) -> Judge:
    """Build a vLLM-backed judge (OpenAI-compatible). Requires the runtime extra."""
    from openai import OpenAI  # lazy

    from ..config import Settings
    from ..runner.agent import _resolve_base_url

    client = OpenAI(
        base_url=_resolve_base_url(base_url_ref),
        api_key=Settings.from_env().vllm_api_key or "not-needed",
    )

    def _judge(prompt: str) -> dict:
        resp = client.chat.completions.create(
            model=model_id,
            messages=[{"role": "user", "content": prompt}],
            temperature=0.0,
            response_format={"type": "json_object"},
        )
        try:
            return json.loads(resp.choices[0].message.content or "{}")
        except json.JSONDecodeError:
            return {"score": 0.0, "passed": False, "issues": ["unparseable critic output"]}

    return _judge


# --- calibration against human labels (the gate on joining the suite) ---


@dataclass
class CalibrationCase:
    """One human-labelled run for measuring critic agreement."""

    name: str
    human_verdict: bool  # True = a human reviewer would pass this run
    context: EvalContext


@dataclass
class Disagreement:
    case: str
    human_verdict: bool
    critic_verdict: bool
    triage: str
    judged: bool


@dataclass
class CalibrationReport:
    cases_total: int
    agreement: float
    false_passes: int   # critic passed what a human failed (the dangerous kind)
    false_fails: int    # critic failed what a human passed (friction)
    judged_calls: int   # how many cases actually spent a judge call
    disagreements: list[Disagreement] = field(default_factory=list)


def load_calibration(path: str | Path) -> list[CalibrationCase]:
    """Load the labelled calibration corpus (see evals/corpora/critic-calibration.yaml)."""
    import yaml

    from ..curriculum.objective import Objective
    from ..runner.result import RunResult

    document = yaml.safe_load(Path(path).read_text())
    cases: list[CalibrationCase] = []
    for entry in document["cases"]:
        run = entry["run"]
        ctx = EvalContext(
            result=RunResult.model_validate(run["result"]),
            objective=Objective.model_validate(entry["objective"]),
            diff=run.get("diff", ""),
            denied_commands=run.get("deniedCommands", []),
        )
        cases.append(
            CalibrationCase(
                name=entry["name"],
                human_verdict=bool(entry["humanVerdict"]),
                context=ctx,
            )
        )
    return cases


def calibrate(judge: Judge, cases: list[CalibrationCase]) -> CalibrationReport:
    """Measure the gated critic (triage + judge) against human labels.

    Calibrates the combination production runs — not the judge alone —
    because triage decides a share of verdicts without the judge.
    """
    if not cases:
        raise ValueError("Cannot calibrate against zero labelled cases.")

    agreements = 0
    false_passes = 0
    false_fails = 0
    judged_calls = 0
    disagreements: list[Disagreement] = []

    for case in cases:
        verdict = gated_critic_eval(case.context, judge)
        if verdict.details.get("judged"):
            judged_calls += 1
        if verdict.passed == case.human_verdict:
            agreements += 1
            continue
        if verdict.passed and not case.human_verdict:
            false_passes += 1
        else:
            false_fails += 1
        disagreements.append(
            Disagreement(
                case=case.name,
                human_verdict=case.human_verdict,
                critic_verdict=verdict.passed,
                triage=str(verdict.details.get("triage")),
                judged=bool(verdict.details.get("judged")),
            )
        )

    return CalibrationReport(
        cases_total=len(cases),
        agreement=agreements / len(cases),
        false_passes=false_passes,
        false_fails=false_fails,
        judged_calls=judged_calls,
        disagreements=disagreements,
    )
