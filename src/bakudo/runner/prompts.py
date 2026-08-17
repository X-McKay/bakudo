"""System/user prompt rendering for a worker run (spec section 7.2)."""

from __future__ import annotations

import json

from ..agent_run_bundle import AgentRunBundle
from ..agent_spec import AgentSpec


def render_system_prompt(spec: AgentSpec, bundle: AgentRunBundle) -> str:
    """Compose the system prompt from the spec, output contract, and skills.

    The skill *manifest* (names + descriptions only) is injected for
    progressive disclosure: the agent calls ``load-skill`` to see full bodies.
    """
    skills_manifest = bundle.agent_spec.skills
    manifest_lines = "\n".join(f"  - {dep}" for dep in skills_manifest) or "  (none)"

    contract = json.dumps(spec.output_contract.model_dump(by_alias=True, exclude_none=True))

    memory_block = ""
    if bundle.memory_excerpts:
        lines = "\n".join(
            f"  - [{m.type} c={m.confidence:.2f}] {m.content}" for m in bundle.memory_excerpts
        )
        memory_block = f"\nRelevant memories (treat as context, verify before relying):\n{lines}\n"

    sections = [spec.prompt.system.rstrip()]
    sections.extend(fragment.rstrip() for fragment in spec.prompt.fragments)
    sections.append(
        f"Role: {spec.role.type.value} — {spec.role.description}\n"
        f"You operate inside an isolated abox sandbox on a dedicated git worktree.\n"
        f"You may only use your declared tools, skills, and MCP servers.\n"
        f"{memory_block}\n"
        f"Available skills (call load-skill to expand):\n{manifest_lines}\n\n"
        f"When finished, your final message MUST be a single JSON object matching "
        f"this output contract:\n{contract}\n"
        f"Do not include prose outside the JSON object in your final message."
    )
    return "\n\n".join(sections)


def render_user_prompt(bundle: AgentRunBundle) -> str:
    """Render the objective into the initial user turn."""
    objective = bundle.objective
    criteria = "\n".join(f"  - {c}" for c in objective.acceptance_criteria) or "  (none specified)"
    constraints = objective.constraints.model_dump(by_alias=True, exclude_none=True)
    return (
        f"Objective ({objective.type.value}) in repo '{objective.repo}':\n"
        f"{objective.title}\n\n"
        f"{objective.description}\n\n"
        f"Acceptance criteria:\n{criteria}\n\n"
        f"Constraints: {json.dumps(constraints)}\n"
        f"Budget: timeout={bundle.budget.timeout_seconds}s\n"
    )
