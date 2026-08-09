"""Phase B1/B3: tool signatures are preserved and query-memory is wired."""

import inspect
from pathlib import Path

import pytest

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


# ---------------------------------------------------------------------------
# ABOX-9: git_diff/changed_files must see untracked (create-only) changes
# ---------------------------------------------------------------------------


def _git_workspace(tmp_path):
    import subprocess

    def git(*args):
        subprocess.run(
            ["git", *args], check=True, cwd=tmp_path, capture_output=True, text=True
        )

    git("init", "-q", "-b", "main")
    git("config", "user.email", "t@t")
    git("config", "user.name", "t")
    git("config", "commit.gpgsign", "false")
    (tmp_path / "existing.py").write_text("original\n")
    git("add", "-A")
    git("commit", "-q", "-m", "init")
    return Workspace(tmp_path)


def test_changed_files_includes_untracked(tmp_path):
    ws = _git_workspace(tmp_path)
    (tmp_path / "existing.py").write_text("modified\n")
    (tmp_path / "brand_new.py").write_text("created\n")
    files = ws.changed_files()
    assert "existing.py" in files
    assert "brand_new.py" in files


def test_git_diff_includes_untracked_content(tmp_path):
    ws = _git_workspace(tmp_path)
    (tmp_path / "brand_new.py").write_text("created content\n")
    diff = ws.git_diff()
    assert "brand_new.py" in diff
    assert "created content" in diff


def test_clean_workspace_reports_no_changes(tmp_path):
    ws = _git_workspace(tmp_path)
    assert ws.changed_files() == []
    assert ws.git_diff() == ""


# --- ABOX-19: strands @tool over functools.partial (live-model path) ---

def test_to_strands_tools_accepts_context_bound_partials():
    """The real strands ``@tool`` decorator rejects bare ``functools.partial``
    objects (no ``__name__``); the adapter must present named callables with
    the ToolContext parameter already stripped from the visible signature.
    Reproduces the run_E2ELIVE2 in-guest TypeError."""
    import functools

    pytest.importorskip("strands")
    from bakudo.runner.agent import to_strands_tools

    def read_file(ctx: object, path: str, max_bytes: int = 65536) -> dict:
        """Read a file from the workspace."""
        return {"ctx": ctx, "path": path, "max_bytes": max_bytes}

    bound = {"read-file": functools.partial(read_file, object())}
    adapted = to_strands_tools(bound)
    assert len(adapted) == 1
    spec = getattr(adapted[0], "tool_spec", None) or {}
    assert (spec.get("name") or getattr(adapted[0], "tool_name", "")) == "read-file"
    # The bound ToolContext must not leak into the model-facing schema.
    schema = str(spec)
    assert "ctx" not in schema
