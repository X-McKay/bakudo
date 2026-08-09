"""Serializable data contracts and constants shared by workflows/activities.

These are plain dataclasses (Temporal serialises them via its dataclass/JSON
converter) and contain no ``temporalio`` imports, so they are safe to import
anywhere — including inside the workflow sandbox.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

# Two task queues separate the trusted control plane from run orchestration.
TASK_QUEUE_CONTROL = "bakudo-control"
TASK_QUEUE_RUNS = "bakudo-runs"

# Default agent per objective type, used when an objective carries no
# ``suggestedAgents`` (TMP-3). Types with no sensible default (eval-author,
# skill-gen, critic-only flows without a critic agent...) resolve to None and
# the meta-agent dead-letters the objective instead of crashing.
DEFAULT_AGENT_BY_TYPE: dict[str, str] = {
    "explore": "explore",
    "add-feature": "add-feature",
    "qa": "qa",
    "critic": "critic",
    "maintenance": "add-feature",
    "optimize": "optimize-scout",
}


def resolve_agent_name(objective: dict[str, Any]) -> str | None:
    """Deterministically resolve the agent name for an objective (TMP-3).

    Order: ``suggestedAgents[0]`` (what observer objectives carry), then the
    per-type default mapping. Returns ``None`` when unresolvable — the caller
    dead-letters, never crashes. Pure and import-safe for workflow code.
    """
    suggested = objective.get("suggestedAgents") or objective.get("suggested_agents")
    if isinstance(suggested, list) and suggested and isinstance(suggested[0], str):
        return suggested[0]
    obj_type = objective.get("type")
    if isinstance(obj_type, str):
        return DEFAULT_AGENT_BY_TYPE.get(obj_type)
    return None


@dataclass
class AgentRunInput:
    """Start one agent spec against one objective in one sandbox."""

    run_id: str
    objective: dict[str, Any]      # Objective.to_dict()
    agent_spec: dict[str, Any]     # AgentSpec schema document
    memory_excerpts: list[dict[str, Any]] = field(default_factory=list)
    eval_rubric: dict[str, Any] = field(default_factory=dict)
    timeout_seconds: int = 3600


@dataclass
class AgentRunOutput:
    run_id: str
    phase: str
    agent_ref: str
    git_branch: str
    result: dict[str, Any] | None = None
    scorecard: dict[str, Any] | None = None
    eval_results: list[dict[str, Any]] = field(default_factory=list)


@dataclass
class EvalInput:
    """Run the eval suite against a collected run."""

    run_id: str
    objective: dict[str, Any]
    result: dict[str, Any]
    diff: str = ""
    denied_commands: list[dict[str, str]] = field(default_factory=list)
    runtime_seconds: float = 0.0
    tokens_used: int = 0
    schema_valid: bool = True


@dataclass
class PromotionInput:
    """Compare a candidate scorecard against a baseline and decide."""

    candidate: dict[str, Any]              # Scorecard dump
    baseline: dict[str, Any] | None = None
    mutation_kinds: list[str] = field(default_factory=list)


@dataclass
class EvolutionInput:
    """Score a candidate spec against a baseline over an eval corpus."""

    baseline_spec: dict[str, Any]
    candidate_spec: dict[str, Any]
    corpus_path: str


@dataclass
class CompactionInput:
    """Compact one run's emitted memories into the durable store."""

    repo: str
    result: dict[str, Any]


@dataclass
class ObserveInput:
    """Collect repository signals and emit candidate objectives.

    ``iterations`` counts Continue-As-New rollovers of the observer loop; it
    lives here because ``continue_as_new`` takes exactly the workflow's run
    arguments.
    """

    repo: str
    iterations: int = 0


@dataclass
class OptimizeInput:
    """Drive one optimize objective through scout → attempts → selection."""

    objective: dict[str, Any]              # Objective.to_dict(), type "optimize"
    scout_spec: dict[str, Any]             # optimize-scout AgentSpec document
    attempt_spec: dict[str, Any]           # optimize-attempt AgentSpec document
    max_rounds: int = 2
    max_approaches: int = 3
    timeout_seconds: int = 3600
