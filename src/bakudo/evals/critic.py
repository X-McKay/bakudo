"""Critic eval: an LLM reviewer scores a run's diff/reasoning (spec section 22.1).

The grader is *judge-injectable*: tests pass a deterministic fake judge; in
production a vLLM-backed judge is built with :func:`llm_judge`. When no judge is
available the critic abstains (passes with a note) rather than blocking.
"""

from __future__ import annotations

import json
import os
from collections.abc import Callable

from .checks import EvalContext
from .result import EvalResult

# A judge maps a review prompt to a verdict dict: {score: 0..1, passed: bool,
# issues: [str]}.
Judge = Callable[[str], dict]


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

    from ..runner.agent import _resolve_base_url

    client = OpenAI(
        base_url=_resolve_base_url(base_url_ref),
        api_key=os.environ.get("VLLM_API_KEY", "not-needed"),
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
