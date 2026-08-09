"""Turn an AgentSpec tool allowlist into concrete, scoped callables.

Each callable returns a JSON-serialisable dict so it can be surfaced uniformly
through Strands and logged for the agent-observability layer (spec section 18.3).
"""

from __future__ import annotations

import functools
import subprocess
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from ..agent_spec import AgentSpec
from ..skills import SkillRegistry
from .policy import REPO_SAFE, CommandDenied, CommandPolicy, policy_by_name
from .workspace import Workspace

# A tool is a named callable returning a JSON-serialisable result.
Tool = Callable[..., dict[str, Any]]

# After this many policy denials in one run, command execution shuts off
# entirely (circuit breaker) — a model fighting the policy wall must be
# bounded deterministically, not by prompt compliance.
DENIAL_CIRCUIT_BREAKER = 5


class BudgetExceeded(Exception):
    """Raised when a run exceeds its time or token budget (spec section 19.1)."""

    def __init__(self, reason: str):
        self.reason = reason
        super().__init__(f"Budget exceeded: {reason}")


@dataclass
class ToolContext:
    """Shared state threaded through every tool invocation in a run.

    Besides the workspace/skills handles, it accumulates the agent-observability
    counters (spec section 18.3) and enforces the run budget (section 19.1): a
    wall-clock deadline and an optional token cap, checked before every tool
    call so a runaway tool loop is stopped with a clear, attributable error.
    """

    workspace: Workspace
    skills: SkillRegistry
    run_id: str
    # Records (command, reason) for every denied command — fed to the safety eval.
    denied_commands: list[dict[str, str]] = field(default_factory=list)
    # Optional control-plane memory retrieval callback (query -> list of dicts).
    memory_query: Callable[[str], list[dict[str, Any]]] | None = None

    # --- budget (section 19.1) ---
    deadline_monotonic: float | None = None
    token_cap: int | None = None

    # --- observability counters (section 18.3) ---
    tool_calls: int = 0
    model_calls: int = 0
    tokens_used: int = 0
    memories_retrieved: int = 0
    skills_loaded: list[str] = field(default_factory=list)

    def set_budget(
        self, *, timeout_seconds: int | None = None, token_cap: int | None = None
    ) -> None:
        if timeout_seconds is not None:
            self.deadline_monotonic = time.monotonic() + timeout_seconds
        self.token_cap = token_cap

    def check_budget(self) -> None:
        if self.deadline_monotonic is not None and time.monotonic() > self.deadline_monotonic:
            raise BudgetExceeded("timeout")
        if self.token_cap is not None and self.tokens_used >= self.token_cap:
            raise BudgetExceeded("token_cap")

    def _enter_tool(self) -> None:
        """Account for a tool call and enforce the budget before running it."""
        self.tool_calls += 1
        self.check_budget()

    def clamp_timeout(self, requested: int) -> int:
        """Clamp a model-supplied command timeout to the remaining wall clock.

        Review finding API-4: ``run-command`` must not let the model extend its
        own budget via the ``timeout`` argument. With no deadline set the
        requested value passes through unchanged.
        """
        if self.deadline_monotonic is None:
            return requested
        remaining = int(self.deadline_monotonic - time.monotonic())
        return max(1, min(requested, remaining))

    def observability(self) -> dict[str, Any]:
        return {
            "tool_calls": self.tool_calls,
            "model_calls": self.model_calls,
            "tokens_used": self.tokens_used,
            "memories_retrieved": self.memories_retrieved,
            "skills_loaded": list(self.skills_loaded),
            "denied_commands": len(self.denied_commands),
        }


def _read_file(ctx: ToolContext, path: str) -> dict[str, Any]:
    ctx._enter_tool()
    return {"path": path, "content": ctx.workspace.read(path)}


def _edit_file(ctx: ToolContext, path: str, content: str) -> dict[str, Any]:
    ctx._enter_tool()
    written = ctx.workspace.write(path, content)
    return {"path": path, "bytes_written": written}


def _make_run_command(policy: CommandPolicy) -> Tool:
    def _run_command(ctx: ToolContext, command: str, timeout: int = 600) -> dict[str, Any]:
        ctx._enter_tool()
        if len(ctx.denied_commands) >= DENIAL_CIRCUIT_BREAKER:
            # Observed live: a read-only role burned 100+ tool calls retrying
            # denied writes via sed/awk workarounds. Past the threshold the
            # policy wall becomes absolute for the rest of the run.
            return {
                "circuit_breaker": True,
                "denied": True,
                "command": command,
                "reason": (
                    "command execution disabled for the rest of this run after "
                    f"{len(ctx.denied_commands)} policy denials. Do not attempt "
                    "further commands or workarounds — produce your final "
                    "report from what you already know, now."
                ),
            }
        try:
            argv = policy.check(command)
        except CommandDenied as denied:
            ctx.denied_commands.append({"command": command, "reason": denied.reason})
            return {
                "denied": True,
                "command": command,
                "reason": (
                    f"{denied.reason}. This is the role's non-negotiable command "
                    "policy, not a transient error — do not retry this command "
                    "or attempt workarounds (sed/awk/shell redirection); "
                    "continue with what the policy allows and report instead."
                ),
            }
        timeout = ctx.clamp_timeout(timeout)
        try:
            proc = ctx.workspace.run(argv, timeout=timeout)
        except subprocess.TimeoutExpired:
            # Report like GNU timeout instead of crashing the tool loop.
            return {
                "command": command,
                "exit_code": 124,
                "timed_out": True,
                "stdout": "",
                "stderr": f"command killed after {timeout}s (timeout)",
            }
        return {
            "command": command,
            "exit_code": proc.returncode,
            "stdout": proc.stdout[-20000:],
            "stderr": proc.stderr[-20000:],
        }

    return _run_command


def _git_diff(ctx: ToolContext) -> dict[str, Any]:
    ctx._enter_tool()
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
    ctx._enter_tool()
    loaded = ctx.skills.load_skill(name)
    ctx.skills_loaded.append(name)
    return loaded


def _query_memory(ctx: ToolContext, query: str) -> dict[str, Any]:
    ctx._enter_tool()
    if ctx.memory_query is None:
        return {"results": [], "note": "memory retrieval not available in this run"}
    results = ctx.memory_query(query)
    ctx.memories_retrieved += len(results)
    return {"results": results}


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
