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


def test_exception_chain_includes_root_cause():
    from bakudo.runner.main import _exception_chain

    try:
        try:
            raise ConnectionRefusedError("dial tcp 1.2.3.4:443 refused")
        except ConnectionRefusedError as inner:
            raise RuntimeError("Connection error.") from inner
    except RuntimeError as exc:
        chain = _exception_chain(exc)
    assert "RuntimeError: Connection error." in chain
    assert "ConnectionRefusedError" in chain and "refused" in chain


def test_partial_text_salvaged_on_max_tokens():
    """A generation clipped by maxTokens must yield the partial assistant
    text (strands appends it to the history before raising), not a dead run."""
    from bakudo.runner.agent import _partial_text_on_max_tokens

    class MaxTokensReachedException(Exception):
        pass

    class FakeAgent:
        messages = [
            {"role": "user", "content": [{"text": "review this"}]},
            {"role": "assistant", "content": [{"text": '{"score": 0.5, "passed":'}]},
        ]

    exc = MaxTokensReachedException("hit the cap")
    assert _partial_text_on_max_tokens(exc, FakeAgent()) == '{"score": 0.5, "passed":'
    assert _partial_text_on_max_tokens(ValueError("other"), FakeAgent()) is None
    class Empty:
        messages = []
    assert _partial_text_on_max_tokens(exc, Empty()) is None


def test_build_model_maps_enable_thinking_to_extra_body(monkeypatch):
    """enableThinking: false must reach the API as
    extra_body.chat_template_kwargs.enable_thinking (verified supported by the
    live vLLM deployment)."""
    import yaml

    pytest.importorskip("strands")
    from bakudo.agent_spec import load_spec_file
    from bakudo.runner.agent import build_model

    monkeypatch.setenv("VLLM_BASE_URL", "https://llm.example/v1")
    doc = yaml.safe_load((AGENTS / "optimize-scout.yaml").read_text())
    spec = load_spec_file(AGENTS / "optimize-scout.yaml")
    model = build_model(spec)
    params = model.config.get("params", {})
    if doc["model"].get("enableThinking") is False:
        assert params["extra_body"]["chat_template_kwargs"]["enable_thinking"] is False
    else:
        assert "extra_body" not in params

    spec_explore = load_spec_file(AGENTS / "explore.yaml")
    assert "extra_body" not in build_model(spec_explore).config.get("params", {})


def test_extract_report_uses_structured_output():
    """The result contract rides strands structured output (schema-enforced),
    with the final text only as fallback — observed live: a scout narrating
    approaches in prose while proposed_followups stayed empty."""
    import json

    from bakudo.runner.agent import _extract_report
    from bakudo.runner.result import AgentReport

    class GoodAgent:
        def structured_output(self, model):
            assert model is AgentReport
            return AgentReport(
                status="success", summary="found it",
                proposed_followups=["Approach 1: use a set"],
            )

    out = json.loads(_extract_report(GoodAgent(), fallback="ignored"))
    assert out["proposed_followups"] == ["Approach 1: use a set"]
    assert out["status"] == "success"


def test_extract_report_falls_back_on_failure():
    from bakudo.runner.agent import _extract_report

    class BrokenAgent:
        def structured_output(self, model):
            raise RuntimeError("provider exploded")

    assert _extract_report(BrokenAgent(), fallback="the final text") == "the final text"
