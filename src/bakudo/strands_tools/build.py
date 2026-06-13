"""Turn an AgentSpec tool allowlist into concrete, scoped callables.

Each callable returns a JSON-serialisable dict so it can be surfaced uniformly
through Strands and logged for the agent-observability layer (spec section 18.3).
"""

from __future__ import annotations

import functools
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from ..agent_spec import AgentSpec
from ..skills import SkillRegistry
from .policy import REPO_SAFE, CommandDenied, CommandPolicy, policy_by_name
from .workspace import Workspace

# A tool is a named callable returning a JSON-serialisable result.
Tool = Callable[..., dict[str, Any]]


@dataclass
class ToolContext:
    """Shared state threaded through every tool invocation in a run."""

    workspace: Workspace
    skills: SkillRegistry
    run_id: str
    # Records (command, reason) for every denied command — fed to the safety eval.
    denied_commands: list[dict[str, str]] = field(default_factory=list)
    # Optional control-plane memory retrieval callback (query -> list of dicts).
    memory_query: Callable[[str], list[dict[str, Any]]] | None = None


def _read_file(ctx: ToolContext, path: str) -> dict[str, Any]:
    return {"path": path, "content": ctx.workspace.read(path)}


def _edit_file(ctx: ToolContext, path: str, content: str) -> dict[str, Any]:
    written = ctx.workspace.write(path, content)
    return {"path": path, "bytes_written": written}


def _make_run_command(policy: CommandPolicy) -> Tool:
    def _run_command(ctx: ToolContext, command: str, timeout: int = 600) -> dict[str, Any]:
        try:
            argv = policy.check(command)
        except CommandDenied as denied:
            ctx.denied_commands.append({"command": command, "reason": denied.reason})
            return {"denied": True, "reason": denied.reason, "command": command}
        proc = ctx.workspace.run(argv, timeout=timeout)
        return {
            "command": command,
            "exit_code": proc.returncode,
            "stdout": proc.stdout[-20000:],
            "stderr": proc.stderr[-20000:],
        }

    return _run_command


def _git_diff(ctx: ToolContext) -> dict[str, Any]:
    return {"diff": ctx.workspace.git_diff(), "changed_files": ctx.workspace.changed_files()}


def _make_run_tests(policy: CommandPolicy) -> Tool:
    runner = _make_run_command(policy)

    def _run_tests(ctx: ToolContext, command: str = "pytest -q") -> dict[str, Any]:
        result = runner(ctx, command)
        status = "error"
        if result.get("denied"):
            status = "error"
        elif result.get("exit_code") == 0:
            status = "passed"
        else:
            status = "failed"
        return {**result, "status": status}

    return _run_tests


def _load_skill(ctx: ToolContext, name: str) -> dict[str, Any]:
    return ctx.skills.load_skill(name)


def _query_memory(ctx: ToolContext, query: str) -> dict[str, Any]:
    if ctx.memory_query is None:
        return {"results": [], "note": "memory retrieval not available in this run"}
    return {"results": ctx.memory_query(query)}


def build_tool_callables(
    spec: AgentSpec, ctx: ToolContext
) -> dict[str, Callable[..., dict[str, Any]]]:
    """Build the ``{tool_name: bound_callable}`` map for a spec.

    Only tools named in the spec are built; ``run-command``/``run-tests`` honour
    the per-tool ``policy`` field (defaulting to ``repo-safe``). ``write-result``
    is intentionally *not* built here — the runner owns result writing.
    """
    policies: dict[str, CommandPolicy] = {}
    for tool in spec.tools:
        if tool.name in ("run-command", "run-tests"):
            policies[tool.name] = policy_by_name(tool.policy) if tool.policy else REPO_SAFE

    factory: dict[str, Tool] = {
        "read-file": _read_file,
        "edit-file": _edit_file,
        "run-command": _make_run_command(policies.get("run-command", REPO_SAFE)),
        "git-diff": _git_diff,
        "run-tests": _make_run_tests(policies.get("run-tests", REPO_SAFE)),
        "load-skill": _load_skill,
        "query-memory": _query_memory,
    }

    bound: dict[str, Callable[..., dict[str, Any]]] = {}
    for tool in spec.tools:
        impl = factory.get(tool.name)
        if impl is None:
            # write-result and unknown tools are handled elsewhere / ignored.
            continue
        # functools.partial binds the ToolContext while preserving the remaining
        # parameters' names and type hints, so Strands can derive a correct
        # input schema for each tool (unlike a **kwargs lambda).
        bound[tool.name] = functools.partial(impl, ctx)
    return bound
