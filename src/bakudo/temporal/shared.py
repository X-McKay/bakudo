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


@dataclass
class AgentRunInput:
    """Start one agent spec against one objective in one sandbox."""

    run_id: str
    objective: dict[str, Any]      # Objective.to_dict()
    agent_spec: dict[str, Any]     # AgentSpec schema document
    memory_excerpts: list[dict[str, Any]] = field(default_factory=list)
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
    # The run's budget (TaskBundle.budget), so the cost gate grades against
    # what the run was actually allowed, not a hardcoded default.
    token_budget: int | None = None
    time_budget_s: float | None = None


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

    ``iterations`` counts Continue-As-New rollovers of the observer loop, and
    ``seen`` carries the (type::title) keys of objectives already emitted so
    an unchanged repo does not refill the meta-agent backlog every cycle;
    both live here because ``continue_as_new`` takes exactly the workflow's
    run arguments.
    """

    repo: str
    iterations: int = 0
    seen: list[str] = field(default_factory=list)


@dataclass
class OptimizeInput:
    """Drive one optimize objective through scout → attempts → selection."""

    objective: dict[str, Any]              # Objective.to_dict(), type "optimize"
    scout_spec: dict[str, Any]             # optimize-scout AgentSpec document
    attempt_spec: dict[str, Any]           # optimize-attempt AgentSpec document
    max_rounds: int = 2
    max_approaches: int = 3
    timeout_seconds: int = 3600
