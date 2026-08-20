"""Execute one environment episode and record its experimental trial.

``run_trial`` provisions a task, derives an :class:`Objective` from its
instruction, hands it to an injected ``pipeline_fn`` (the CLI wires the real
:func:`bakudo.control.pipeline.run_objective`; tests wire a stub), grades the
resulting diff against privileged verifier inputs (:mod:`bakudo.trials.verifier`),
computes integrity violations (:class:`~bakudo.trials.models.IntegrityFlags`), and
records the outcome as an immutable :class:`~bakudo.trials.models.TrialRecord`.
"""

from __future__ import annotations

import tempfile
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace
from typing import TYPE_CHECKING, Any, Protocol

from .. import __version__
from ..agent_spec.models import NetworkMode, SpecBudget
from ..curriculum.objective import Constraints, Objective, ObjectiveType
from ..ids import new_episode_id, new_trial_id
from ..tasks.models import ConstraintSpec, ResourceLimits
from ..tasks.provision import provision
from ..tasks.source import LoadedTask
from ..tasks.verifier_runner import VerifierRunner
from . import verifier
from .models import IntegrityFlags, TrialRecord

if TYPE_CHECKING:
    from ..abox.runner import AboxOutcome
    from ..agent_run_bundle import AgentRunBundle
    from ..agent_spec import AgentSpec

# Any changed file whose path contains one of these markers is grounds for a
# verifier-input integrity result -- a candidate that edits the very inputs grading
# it (or CI/verifier-test scaffolding) is gaming the task, not solving it.
_PRIVILEGED_PATH_MARKERS = ("tests/", "test_", "conftest.py", ".github/", "verifier/")

# Network mode strictness order (least -> most permissive); intersection
# picks whichever side is more restrictive (i.e. has the lower index).
_NETWORK_ORDER = {"none": 0, "scoped": 1, "open": 2}


class PipelineResultLike(Protocol):
    """The shape ``pipeline_fn`` must return -- either a stub (tests) or the
    CLI's adapter over the real :class:`bakudo.control.pipeline.PipelineResult`.

    ``metrics`` is read defensively (``getattr(pr, "metrics", None) or {}``)
    by :func:`run_trial`, not required structurally here, so pre-existing
    stubs across the test suite that don't set it keep working unchanged --
    absent keys default to ``0.0`` in the recorded :class:`TrialRecord`.
    """

    diff: str
    result: Any
    denied_commands: list[str]
    scorecard: Any
    metrics: dict[str, float]


PipelineFn = Callable[[Objective, str, ResourceLimits, str], PipelineResultLike]


def objective_from_task(task: LoadedTask, repo_path: str | Path) -> Objective:
    """Derive the :class:`Objective` a policy attempts from a task instruction.

    ``repo`` is set to the caller-provided materialized workspace path (or a
    stable ``task://`` locator for corpus-only evaluation), rather than a bare
    repository name to resolve elsewhere. The TaskSpec's hard constraints
    remain authoritative; only the subset understood by the generic Objective
    contract is projected.
    """
    instruction = task.spec.instruction
    objective_type = ObjectiveType(instruction.type)
    # ``TaskInstruction.type: optimize`` describes a code-level optimization
    # task.  It does not carry the trusted, pinned performance contract that
    # an orchestration-level ``ObjectiveType.optimize`` requires before it can
    # participate in performance promotion.  Materialise such benchmark tasks
    # as maintenance work; their task-local verifier and constraints remain
    # authoritative and no unpinned performance claim is introduced.
    if objective_type is ObjectiveType.optimize:
        objective_type = ObjectiveType.maintenance
    constraints_data: dict[str, Any] = {"maxFilesChanged": task.spec.constraints.max_changed_files}
    return Objective(
        type=objective_type,
        repo=str(repo_path),
        title=instruction.title,
        description=instruction.description,
        acceptance_criteria=list(instruction.success_criteria),
        constraints=Constraints.model_validate(constraints_data),
    )


def intersect_budgets(agent: SpecBudget | None, task: ResourceLimits) -> dict[str, int]:
    """Per-field ``min()`` of whichever side has a value -- tighten-only.

    A field absent on both sides is omitted; present on only one side, that
    side's value wins outright (there is nothing to tighten against).
    """
    agent_tokens = agent.max_tokens if agent is not None else None
    agent_tool_calls = agent.max_tool_calls if agent is not None else None
    fields = (
        ("wall_seconds", None, task.wall_seconds),
        ("tool_calls", agent_tool_calls, task.tool_calls),
        ("tokens", agent_tokens, task.tokens),
    )
    result: dict[str, int] = {}
    for key, agent_value, task_value in fields:
        values = [v for v in (agent_value, task_value) if v is not None]
        if values:
            result[key] = min(values)
    return result


def intersect_network(agent_mode: str, task_mode: str) -> str:
    """The more restrictive of two network modes (``none < scoped < open``)."""
    if _NETWORK_ORDER[agent_mode] <= _NETWORK_ORDER[task_mode]:
        return agent_mode
    return task_mode


def build_pipeline_fn(
    spec: AgentSpec,
    *,
    sandbox_fn: Callable[[AgentRunBundle, Path], AboxOutcome],
    run_objective_fn: Callable[..., Any] | None = None,
) -> PipelineFn:
    """Build a ``pipeline_fn`` for :func:`run_trial` from a concrete agent spec.

    Shared by every real caller, including the CLI and experiment paths, so
    the budget/network intersection and
    the ``run_objective`` adapter shape live in exactly one place.

    Before invoking ``run_objective_fn`` (defaults to the real
    :func:`bakudo.control.pipeline.run_objective`), the task's own
    budgets/network ceiling (what ``run_trial`` passes in) is intersected
    against ``spec``'s own budget/network via :func:`intersect_budgets` /
    :func:`intersect_network` -- tighten-only in both directions, including
    the wall-clock timeout (an agent's own sandbox timeout can only ever be
    shortened here, never loosened by a looser task ceiling).

    ``sandbox_fn(bundle, repo_path)`` wires the sandbox to the trial's
    already-provisioned workspace (``objective.repo``, set by
    :func:`objective_from_task`) -- e.g.
    ``lambda bundle, repo_path: local_sandbox(bundle, workspace_root=repo_path)``
    for the offline path, or an abox-backed equivalent for a live one.
    """
    # Resolved into a new, non-Optional local (rather than rebinding the
    # Optional parameter) because `pipeline_fn` below closes over it: mypy
    # does not re-narrow a captured variable's type inside a nested function
    # body from an `if x is None: x = ...` in the enclosing scope, so the
    # closure read still saw the parameter's original `Callable[..., Any] |
    # None` type and flagged the call as "None not callable".
    resolved_run_objective_fn: Callable[..., Any]
    if run_objective_fn is not None:
        resolved_run_objective_fn = run_objective_fn
    else:
        from ..control.pipeline import run_objective

        resolved_run_objective_fn = run_objective

    def pipeline_fn(
        objective: Objective, agent_ref: str, budgets: ResourceLimits, network: str
    ) -> PipelineResultLike:
        merged_budget = intersect_budgets(spec.budget, budgets)
        merged_network = intersect_network(spec.sandbox.network_mode.value, network)

        budget_updates: dict[str, Any] = dict(spec.budget.model_dump()) if spec.budget else {}
        if "tokens" in merged_budget:
            budget_updates["max_tokens"] = merged_budget["tokens"]
        if "tool_calls" in merged_budget:
            budget_updates["max_tool_calls"] = merged_budget["tool_calls"]

        # Tighten-only: the agent's own sandbox timeout is a ceiling too, so
        # a *looser* task wallSeconds must never widen it.
        timeout_seconds = spec.sandbox.timeout_seconds
        if "wall_seconds" in merged_budget:
            timeout_seconds = min(timeout_seconds, merged_budget["wall_seconds"])

        adjusted_spec = spec.model_copy(
            update={
                "sandbox": spec.sandbox.model_copy(
                    update={
                        "network_mode": NetworkMode(merged_network),
                        "timeout_seconds": timeout_seconds,
                    }
                ),
                "budget": SpecBudget(**budget_updates) if budget_updates else spec.budget,
            }
        )

        repo_path = Path(objective.repo)
        pipeline_result = resolved_run_objective_fn(
            objective, adjusted_spec, sandbox=lambda bundle: sandbox_fn(bundle, repo_path)
        )
        outcome = pipeline_result.outcome
        # Cost signals (AboxOutcome, mirrored from result.json's metrics by
        # abox/runner.py's _apply_result_signals / abox/local.py's
        # ToolContext.observability()) -- run_trial merges these into
        # TrialRecord.metrics so secondary metrics/costDelta are populated in
        # real runs instead of structurally 0.0. Read via getattr: a real
        # AboxOutcome always has these (0/0.0/{} defaults on the dataclass
        # itself), but a bare test double standing in for one may not.
        observability = getattr(outcome, "observability", None) or {}
        return SimpleNamespace(
            diff=outcome.diff,
            result=pipeline_result.result,
            denied_commands=[d.get("command", "") for d in outcome.denied_commands],
            scorecard=pipeline_result.scorecard,
            pins={"model_id": spec.model.model_id, "sandbox_profile": spec.sandbox.profile},
            metrics={
                "tokens": float(getattr(outcome, "tokens_used", 0) or 0),
                "tool_calls": float(observability.get("tool_calls", 0) or 0),
                "duration_s": float(getattr(outcome, "runtime_seconds", 0.0) or 0.0),
            },
        )

    return pipeline_fn


def changed_files_from_diff(diff: str) -> list[str]:
    """Parse the file paths touched by a unified diff (F2 fix).

    The trusted signal for integrity-flag/metrics purposes: an agent's own
    self-reported ``result.changed_files`` can be wrong or deliberately
    incomplete (e.g. omitting a ``tests/`` edit it made), but the collected
    diff cannot lie about what it actually contains. Handles:

    * ``+++ b/<path>`` -- an added or modified file (the new-side path).
    * ``--- a/<path>`` paired with a ``+++ /dev/null`` on the very next
      line -- a deleted file (there is no new-side path to read).
    * ``rename to <path>`` -- a pure rename with no content change, which
      git emits with no ``---``/``+++`` pair at all.

    Returns paths in first-seen order, de-duplicated. Unparseable/empty
    input yields an empty list rather than raising -- the diff is trusted
    but not assumed well-formed.
    """
    paths: list[str] = []
    seen: set[str] = set()

    def _add(path: str) -> None:
        if path and path not in seen:
            seen.add(path)
            paths.append(path)

    lines = diff.splitlines()
    for i, line in enumerate(lines):
        if line.startswith("+++ "):
            target = line[4:].strip()
            if target == "/dev/null":
                continue
            _add(target[2:] if target.startswith("b/") else target)
        elif line.startswith("--- "):
            source = line[4:].strip()
            if source == "/dev/null":
                continue
            nxt = lines[i + 1] if i + 1 < len(lines) else ""
            if nxt.startswith("+++ ") and nxt[4:].strip() == "/dev/null":
                _add(source[2:] if source.startswith("a/") else source)
        elif line.startswith("rename to "):
            _add(line[len("rename to ") :].strip())

    return paths


def _within_scope(changed_file: str, allowed_paths: list[str]) -> bool:
    for allowed in allowed_paths:
        prefix = allowed.rstrip("/")
        if changed_file == prefix or changed_file.startswith(prefix + "/"):
            return True
    return False


def compute_integrity_flags(
    changed_files: list[str], denied_commands: list[str], constraints: ConstraintSpec
) -> IntegrityFlags:
    """Evaluate hard constraints and integrity signals for one episode."""
    details: dict[str, str] = {}

    violating = [
        path for path in changed_files if any(marker in path for marker in _PRIVILEGED_PATH_MARKERS)
    ]
    verifier_input_violation = constraints.verifier_inputs_immutable and bool(violating)
    if verifier_input_violation:
        details["verifier_input_violation"] = ", ".join(sorted(violating))

    denied_action_violation = constraints.forbids_denied_actions and bool(denied_commands)
    if denied_action_violation:
        details["denied_action_violation"] = ", ".join(sorted(set(denied_commands)))

    outside = [
        path for path in changed_files if not _within_scope(path, constraints.allowed_change_paths)
    ]
    scope_violation = bool(outside)
    if outside:
        details["scope_violation"] = ", ".join(sorted(outside))

    change_limit_violation = len(set(changed_files)) > constraints.max_changed_files
    if change_limit_violation:
        details["change_limit_violation"] = (
            f"{len(set(changed_files))} changed files exceeds "
            f"maxChangedFiles={constraints.max_changed_files}"
        )

    return IntegrityFlags(
        verifier_input_violation=verifier_input_violation,
        denied_action_violation=denied_action_violation,
        scope_violation=scope_violation,
        change_limit_violation=change_limit_violation,
        details=details,
    )


def _status_str(result: Any) -> str | None:
    status = getattr(result, "status", None)
    if status is None:
        return None
    return str(getattr(status, "value", status))


def _to_dict(obj: Any) -> Any:
    if obj is None or isinstance(obj, dict):
        return obj
    if hasattr(obj, "model_dump"):
        return obj.model_dump(mode="json")
    return obj


def run_trial(
    task: LoadedTask,
    agent_ref: str,
    seed: int,
    *,
    pipeline_fn: PipelineFn,
    verifier_runner: VerifierRunner,
    ledger: Any,
    experiment_id: str | None = None,
) -> TrialRecord:
    """Run one task against one agent version and record the outcome.

    Flow: provision the task's fixture -> derive its Objective ->
    ``pipeline_fn(objective, agent_ref, task.limits, task.network)``
    (the task's own resource limits and network constraint are handed down; an
    agent-side ``pipeline_fn`` -- e.g. the CLI's real adapter -- further
    tightens them against the agent spec via :func:`intersect_budgets` /
    :func:`intersect_network` before actually running) -> grade the
    resulting diff with the verifier -> compute integrity flags -> record
    an immutable :class:`TrialRecord` via ``ledger.record_trial`` and return
    it.
    """
    started_at = datetime.now(UTC).isoformat()
    with tempfile.TemporaryDirectory(prefix="bakudo-trial-") as tmp:
        ws = provision(task, Path(tmp), seed=seed)
        objective = objective_from_task(task, ws.repo_path)

        pr = pipeline_fn(objective, agent_ref, task.spec.limits, task.spec.environment.network)

        diff = pr.diff or ""
        # F2 fix: the collected diff is the trusted source of changed
        # paths; self-reported result.changed_files can only ADD to it
        # (belt and braces for a diff the parser mis-reads), never remove
        # from it -- an agent that self-reports an empty/partial list must
        # not thereby dodge verifier-input or scope validation.
        self_reported_changed_files = list(getattr(pr.result, "changed_files", None) or [])
        changed_files = sorted(
            set(changed_files_from_diff(diff)) | set(self_reported_changed_files)
        )
        denied_commands = list(pr.denied_commands or [])

        verifier_outcome = verifier.evaluate(task, diff, seed, verifier_runner)
        integrity = compute_integrity_flags(changed_files, denied_commands, task.spec.constraints)

        actual_status = _status_str(pr.result)
        expected_status = task.spec.constraints.expected_status

        evaluation = {
            "f2p_rate": verifier_outcome.f2p_rate,
            "p2p_rate": verifier_outcome.p2p_rate,
            "reward": verifier_outcome.reward,
            "detail": verifier_outcome.detail,
            "expected_status": expected_status,
            "actual_status": actual_status,
            "status_match": actual_status == expected_status,
            "scorecard": _to_dict(pr.scorecard),
        }

        # Cost signals (tokens/tool_calls/duration_s) come from pipeline_fn's
        # own return, when it sets one -- build_pipeline_fn's real adapter
        # always does (from the AboxOutcome); a bare test stub that doesn't
        # set `metrics` defaults every key to 0.0 rather than omitting them,
        # so a downstream experiment's secondary-metric/costDelta reads never
        # have to special-case a missing key.
        pipeline_metrics = getattr(pr, "metrics", None) or {}
        metrics = {
            "changed_files": float(len(changed_files)),
            "diff_bytes": float(len(diff.encode("utf-8"))),
            "tokens": float(pipeline_metrics.get("tokens", 0.0)),
            "tool_calls": float(pipeline_metrics.get("tool_calls", 0.0)),
            "duration_s": float(pipeline_metrics.get("duration_s", 0.0)),
        }

        runtime_pins = {"bakudo": __version__}
        runtime_pins.update(getattr(pr, "pins", None) or {})

        record = TrialRecord(
            id=new_trial_id(),
            episode_id=new_episode_id(),
            experiment_id=experiment_id,
            agent_ref=agent_ref,
            task=task.pin,
            seed=seed,
            runtime_pins=runtime_pins,
            metrics=metrics,
            evaluation=evaluation,
            integrity=integrity,
            status="completed",
            started_at=started_at,
            completed_at=datetime.now(UTC).isoformat(),
        )
        ledger.record_trial(record)
        return record


@dataclass
class _StubPipelineResult:
    """Convenience constructor tests can use for the ``pipeline_fn`` return
    shape (``diff``, ``result``, ``denied_commands``, ``scorecard``,
    ``metrics``)."""

    diff: str
    result: Any
    denied_commands: list[str]
    scorecard: Any = None
    metrics: dict[str, float] = field(default_factory=dict)
