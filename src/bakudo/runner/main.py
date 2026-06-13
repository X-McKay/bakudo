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
from pathlib import Path

from .. import ids
from ..agent_spec import load_spec_file
from ..bundle import Budget, TaskBundle
from ..curriculum.objective import Objective
from ..skills import SkillRegistry
from ..strands_tools import ToolContext, Workspace
from .agent import build_and_run
from .result import normalize_result


def _load_bundle(args: argparse.Namespace) -> TaskBundle:
    if args.bundle:
        data = json.loads(Path(args.bundle).read_text())
        return TaskBundle.model_validate(data)

    spec = load_spec_file(args.spec)
    objective = Objective.model_validate(json.loads(Path(args.objective).read_text()))
    return TaskBundle(
        run_id=args.run_id or ids.run_id(),
        objective_id=objective.id,
        objective=objective,
        agent_spec=spec,
        budget=Budget(timeoutSeconds=spec.sandbox.timeout_seconds),
    )


def run(args: argparse.Namespace) -> int:
    bundle = _load_bundle(args)
    spec = bundle.agent_spec

    workspace = Workspace(Path(args.workspace))
    skills = SkillRegistry(allowed=spec.skills)
    ctx = ToolContext(
        workspace=workspace, skills=skills, run_id=bundle.run_id,
        memory_query=bundle.memory_query,
    )

    try:
        raw = build_and_run(spec, bundle, ctx)
    except Exception as exc:  # noqa: BLE001 - surface any runtime failure as a result
        raw = json.dumps(
            {
                "status": "failed",
                "summary": f"Runner error: {type(exc).__name__}: {exc}",
                "blocked_reasons": ["runner_exception"],
            }
        )

    result = normalize_result(
        raw,
        run_id=bundle.run_id,
        agent=spec.ref,
        objective_id=bundle.objective_id,
    )

    # Backfill observed changes and denied-command safety signal.
    if not result.changed_files:
        result.changed_files = workspace.changed_files()
    if ctx.denied_commands:
        result.blocked_reasons.extend(
            f"denied:{d['reason']}" for d in ctx.denied_commands
        )

    result_path = Path(args.result)
    result_path.parent.mkdir(parents=True, exist_ok=True)
    result_path.write_text(json.dumps(result.to_dict(), indent=2))

    print(f"[agent-runner] {spec.ref} -> {result.status.value}: {result.summary}")
    return 0 if result.status.value != "failed" else 1


def cli(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="agent-runner", description=__doc__)
    parser.add_argument("--bundle", help="Path to a pre-rendered TaskBundle JSON.")
    parser.add_argument("--spec", help="Path to the AgentSpec YAML.")
    parser.add_argument("--objective", help="Path to the objective JSON.")
    parser.add_argument(
        "--result",
        default="/workspace/.agent/result.json",
        help="Where to write result.json.",
    )
    parser.add_argument(
        "--workspace", default="/workspace", help="Path to the git worktree."
    )
    parser.add_argument("--run-id", help="Canonical run id (defaults to a fresh ULID).")
    args = parser.parse_args(argv)

    if not args.bundle and not (args.spec and args.objective):
        parser.error("provide --bundle, or both --spec and --objective")
    return run(args)


if __name__ == "__main__":  # pragma: no cover
    sys.exit(cli())
