"""The RunResult contract and normalisation (spec section 12.2).

``normalize_result`` is deliberately forgiving on input (models return messy,
partially-structured text) but strict on output: the value it produces always
validates against ``schemas/result.schema.json``.
"""

from __future__ import annotations

import json
import re
from enum import Enum
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from ..schema import validate_result


class RunStatus(str, Enum):
    success = "success"
    blocked = "blocked"
    failed = "failed"


class TestRun(BaseModel):
    model_config = ConfigDict(extra="allow")
    command: str
    status: str  # passed | failed | skipped | error


class MemoryToWrite(BaseModel):
    model_config = ConfigDict(extra="allow")
    type: str
    content: str
    evidence: list[Any] = Field(default_factory=list)
    confidence: float = 0.0


class SkillSuggestion(BaseModel):
    model_config = ConfigDict(extra="allow")
    name: str
    why: str


class AgentReport(BaseModel):
    """What the *model* authors about its run — extracted via strands
    structured output (schema-enforced tool-use), so payload fields like
    ``proposed_followups`` cannot end up narrated in the summary instead.
    Identity and observability fields are runner-owned and excluded."""

    status: RunStatus
    summary: str
    changed_files: list[str] = Field(default_factory=list)
    tests_run: list[TestRun] = Field(default_factory=list)
    metrics: dict[str, float] = Field(default_factory=dict)
    blocked_reasons: list[str] = Field(default_factory=list)
    proposed_followups: list[str] = Field(default_factory=list)
    memories_to_write: list[MemoryToWrite] = Field(default_factory=list)
    skill_suggestions: list[SkillSuggestion] = Field(default_factory=list)


class RunResult(BaseModel):
    """The structured output every worker run writes to ``result.json``."""

    model_config = ConfigDict(populate_by_name=True)

    run_id: str
    agent: str
    objective_id: str
    status: RunStatus
    summary: str
    changed_files: list[str] = Field(default_factory=list)
    tests_run: list[TestRun] = Field(default_factory=list)
    # Numeric measurements a run reports about its own outcome, e.g. the
    # optimize role's bench_seconds_before/after and complexity_before/after.
    metrics: dict[str, float] = Field(default_factory=dict)
    blocked_reasons: list[str] = Field(default_factory=list)
    proposed_followups: list[str] = Field(default_factory=list)
    memories_to_write: list[MemoryToWrite] = Field(default_factory=list)
    skill_suggestions: list[SkillSuggestion] = Field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return self.model_dump(mode="json")

    def validate_against_schema(self) -> None:
        validate_result(self.to_dict())


def _looks_like_verdict(data: dict[str, Any]) -> bool:
    """A bare critic verdict per the pinned contract: {score, passed[, issues]}."""
    return (
        "score" in data
        and "passed" in data
        and "status" not in data
        and isinstance(data.get("score"), (int, float))
    )


def _fold_verdict(data: dict[str, Any]) -> dict[str, Any]:
    """Fold a bare verdict into the RunResult envelope (design §5).

    The critic *run* succeeded — it produced a verdict; whether the verdict is
    positive lives in ``metrics.passed`` for ``critic_eval`` to grade.
    """
    issues = [str(i) for i in data.get("issues") or []]
    score = float(data["score"])
    return {
        "status": "success",
        "summary": f"Critic verdict: score {score}, passed {bool(data['passed'])}."
        + (f" Issues: {'; '.join(issues[:3])}" if issues else ""),
        "metrics": {"score": score, "passed": 1.0 if data["passed"] else 0.0},
        "proposed_followups": issues,
    }


def _extract_json_blob(text: str) -> dict[str, Any] | None:
    """Best-effort recovery of a JSON object embedded in free-form model text."""
    # Prefer a fenced ```json block, then fall back to the first {...} span.
    fence = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.DOTALL)
    candidates = []
    if fence:
        candidates.append(fence.group(1))
    brace = re.search(r"\{.*\}", text, re.DOTALL)
    if brace:
        candidates.append(brace.group(0))
    for blob in candidates:
        try:
            parsed = json.loads(blob)
            if isinstance(parsed, dict):
                return parsed
        except json.JSONDecodeError:
            continue
    return None


def normalize_result(
    raw: Any,
    *,
    run_id: str,
    agent: str,
    objective_id: str,
) -> RunResult:
    """Coerce a worker's output into a schema-valid :class:`RunResult`.

    Accepts a dict, a JSON string, or arbitrary model text containing a JSON
    object. Missing required identity fields are backfilled from the known run
    context so the result is always attributable.
    """
    data: dict[str, Any] | None
    if isinstance(raw, dict):
        data = dict(raw)
    elif isinstance(raw, str):
        try:
            parsed = json.loads(raw)
            data = parsed if isinstance(parsed, dict) else _extract_json_blob(raw)
        except json.JSONDecodeError:
            data = _extract_json_blob(raw)
    else:
        data = None

    if data is None:
        # The agent failed to emit a parseable result; record that as a failure
        # rather than crashing the run.
        data = {
            "status": "failed",
            "summary": "Agent did not produce a parseable result.json.",
            "blocked_reasons": ["unparseable_output"],
        }
    elif _looks_like_verdict(data):
        data = _fold_verdict(data)

    data.setdefault("run_id", run_id)
    data.setdefault("agent", agent)
    data.setdefault("objective_id", objective_id)
    data.setdefault("status", "failed")
    data.setdefault("summary", "")

    result = RunResult.model_validate(data)
    result.validate_against_schema()
    return result
