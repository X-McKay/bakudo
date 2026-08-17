"""``agent-runner`` — the worker-plane entrypoint launched inside abox.

Invocation (spec section 6.2)::

    agent-runner \\
      --spec /abox-meta/agent.yaml \\
      --objective /abox-meta/objective.json \\
      --result /workspace/.agent/result.json

Or, with a pre-rendered task bundle::

    agent-runner --bundle /abox-meta/bundle.json --result /workspace/.agent/result.json
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

from .. import ids
from ..agent_run_bundle import AgentRunBundle, budget_from_spec
from ..agent_spec import load_spec_file
from ..curriculum.objective import Objective
from ..skills import SkillRegistry
from ..strands_tools import ToolContext, Workspace
from .agent import build_and_run
from .result import RunResult, RunStatus, normalize_result


def _exception_chain(exc: BaseException, limit: int = 4) -> str:
    """``Type: msg (caused by Type: msg ...)`` — the outermost exception alone
    (e.g. openai's generic ``APIConnectionError: Connection error.``) routinely
    hides the actionable root cause, and the summary is often the only
    diagnostic that leaves the sandbox."""
    parts: list[str] = []
    seen: set[int] = set()
    cur: BaseException | None = exc
    while cur is not None and id(cur) not in seen and len(parts) < limit:
        seen.add(id(cur))
        parts.append(f"{type(cur).__name__}: {cur}")
        cur = cur.__cause__ or cur.__context__
    return " (caused by ".join(parts) + ")" * (len(parts) - 1)


def _load_bundle(args: argparse.Namespace) -> AgentRunBundle:
    if args.bundle:
        data = json.loads(Path(args.bundle).read_text())
        return AgentRunBundle.model_validate(data)

    spec = load_spec_file(args.spec)
    objective = Objective.model_validate(json.loads(Path(args.objective).read_text()))
    return AgentRunBundle(
        run_id=args.run_id or ids.run_id(),
        objective_id=objective.id,
        objective=objective,
        agent_spec=spec,
        budget=budget_from_spec(spec),
    )


def run(args: argparse.Namespace) -> int:
    try:
        bundle = _load_bundle(args)
    except Exception as exc:  # noqa: BLE001 - version skew must be diagnosable
        # A bundle this runner can't parse (typically control-plane/worker-plane
        # version skew: the worker vendored an older bakudo than the control
        # plane that rendered the bundle) still gets a failed result.json —
        # identity fields recovered best-effort from the raw document.
        raw_ids: dict[str, str] = {}
        if args.bundle:
            try:
                doc = json.loads(Path(args.bundle).read_text())
                raw_ids = {
                    k: doc[k] for k in ("run_id", "objective_id") if isinstance(doc.get(k), str)
                }
            except Exception:  # noqa: BLE001 - identity recovery is best-effort
                pass
        failure = {
            "run_id": raw_ids.get("run_id", "run_" + "0" * 26),
            "agent": "unknown@0",
            "objective_id": raw_ids.get("objective_id", "obj_" + "0" * 26),
            "status": "failed",
            "summary": (
                "Runner could not load the task bundle (control/worker version "
                f"skew?): {_exception_chain(exc)}"
            ),
            "blocked_reasons": ["bundle_incompatible"],
        }
        Path(args.result).parent.mkdir(parents=True, exist_ok=True)
        Path(args.result).write_text(json.dumps(failure, indent=2))
        return 1
    spec = bundle.agent_spec

    workspace = Workspace(Path(args.workspace))
    skills = SkillRegistry(allowed=spec.skills)
    ctx = ToolContext(
        workspace=workspace,
        skills=skills,
        run_id=bundle.run_id,
        memory_query=bundle.memory_query,
    )

    started = time.monotonic()
    try:
        raw = build_and_run(spec, bundle, ctx)
    except Exception as exc:  # noqa: BLE001 - surface any runtime failure as a result
        raw = json.dumps(
            {
                "status": "failed",
                "summary": f"Runner error: {_exception_chain(exc)}",
                "blocked_reasons": ["runner_exception"],
            }
        )
    runtime_seconds = time.monotonic() - started

    try:
        result = normalize_result(
            raw,
            run_id=bundle.run_id,
            agent=spec.ref,
            objective_id=bundle.objective_id,
        )
    except Exception as exc:  # noqa: BLE001 - a bad result must not lose the run
        # Observed live: schema-invalid model output crashed the runner here,
        # leaving NO result.json — worse than a failed-but-diagnosable one.
        # Built directly (not via normalize_result) so it cannot re-fail.
        result = RunResult(
            run_id=bundle.run_id,
            agent=spec.ref,
            objective_id=bundle.objective_id,
            status=RunStatus.failed,
            summary=f"Result normalization failed: {_exception_chain(exc)}",
            blocked_reasons=["result_normalization_failed"],
        )

    # Backfill observed changes and denied-command safety signal.
    if not result.changed_files:
        result.changed_files = workspace.changed_files()
    if ctx.denied_commands:
        result.blocked_reasons.extend(f"denied:{d['reason']}" for d in ctx.denied_commands)

    # Self-report observability so the host/evals never grade empty signals
    # (ABOX-10). result.schema.json only allows numeric metrics, so the
    # counters land there; the agent's own metrics keep precedence.
    observability = ctx.observability()
    for key in (
        "tool_calls",
        "model_calls",
        "tokens_used",
        "memories_retrieved",
    ):
        result.metrics.setdefault(key, float(observability[key]))
    result.metrics.setdefault("denied_commands", float(len(ctx.denied_commands)))
    result.metrics.setdefault("skills_loaded", float(len(ctx.skills_loaded)))
    result.metrics.setdefault("runtime_seconds", round(runtime_seconds, 3))

    result_path = Path(args.result)
    result_path.parent.mkdir(parents=True, exist_ok=True)
    result_path.write_text(json.dumps(result.to_dict(), indent=2))

    print(f"[agent-runner] {spec.ref} -> {result.status.value}: {result.summary}")
    return 0 if result.status.value != "failed" else 1


def cli(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="agent-runner", description=__doc__)
    parser.add_argument("--bundle", help="Path to a pre-rendered AgentRunBundle JSON.")
    parser.add_argument("--spec", help="Path to the AgentSpec YAML.")
    parser.add_argument("--objective", help="Path to the objective JSON.")
    parser.add_argument(
        "--result",
        default="/workspace/.agent/result.json",
        help="Where to write result.json.",
    )
    parser.add_argument("--workspace", default="/workspace", help="Path to the git worktree.")
    parser.add_argument("--run-id", help="Canonical run id (defaults to a fresh ULID).")
    args = parser.parse_args(argv)

    if not args.bundle and not (args.spec and args.objective):
        parser.error("provide --bundle, or both --spec and --objective")
    return run(args)


if __name__ == "__main__":  # pragma: no cover
    sys.exit(cli())
