"""Phase B1/B3: tool signatures are preserved and query-memory is wired."""

import inspect
from pathlib import Path

from bakudo.agent_spec import load_spec_file
from bakudo.bundle import MemoryExcerpt, TaskBundle
from bakudo.curriculum import Objective
from bakudo.skills import SkillRegistry
from bakudo.strands_tools import ToolContext, Workspace, build_tool_callables

AGENTS = Path(__file__).resolve().parents[1] / "agents"


def _bundle():
    spec = load_spec_file(AGENTS / "explore.yaml")
    objective = Objective(type="explore", repo="bakudo", title="map it")
    return TaskBundle(
        run_id="run_X",
        objective_id=objective.id,
        objective=objective,
        agent_spec=spec,
        memory_excerpts=[
            MemoryExcerpt(id="mem_1", type="repo_fact",
                          content="Webhook retries live in src/webhooks/retry.py.",
                          confidence=0.9),
            MemoryExcerpt(id="mem_2", type="repo_fact",
                          content="Billing events are in src/billing/events.py.",
                          confidence=0.8),
        ],
    )


def _ctx(bundle, tmp_path):
    return ToolContext(
        workspace=Workspace(tmp_path),
        skills=SkillRegistry(allowed=bundle.agent_spec.skills),
        run_id=bundle.run_id,
        memory_query=bundle.memory_query,
    )


def test_query_memory_returns_matching_excerpts(tmp_path):
    bundle = _bundle()
    tools = build_tool_callables(bundle.agent_spec, _ctx(bundle, tmp_path))
    out = tools["query-memory"](query="webhook")
    assert len(out["results"]) == 1
    assert "retry.py" in out["results"][0]["content"]


def test_bound_tools_preserve_parameter_signature(tmp_path):
    bundle = _bundle()
    tools = build_tool_callables(bundle.agent_spec, _ctx(bundle, tmp_path))
    # The ToolContext is bound away; the model-facing parameter remains.
    params = inspect.signature(tools["read-file"]).parameters
    assert "ctx" not in params
    assert "path" in params
