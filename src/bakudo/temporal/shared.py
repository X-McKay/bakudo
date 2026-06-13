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
