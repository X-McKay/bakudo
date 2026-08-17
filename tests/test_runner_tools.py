"""Phase B1/B3: tool signatures are preserved and query-memory is wired."""

import inspect
from pathlib import Path

import pytest

from bakudo.agent_run_bundle import AgentRunBundle, MemoryExcerpt
from bakudo.agent_spec import load_spec_file
from bakudo.curriculum import Objective
from bakudo.skills import SkillRegistry
from bakudo.strands_tools import ToolContext, Workspace, build_tool_callables

AGENTS = Path(__file__).resolve().parents[1] / "agents"


def _bundle():
    spec = load_spec_file(AGENTS / "explore.yaml")
    objective = Objective(type="explore", repo="bakudo", title="map it")
    return AgentRunBundle(
        run_id="run_X",
        objective_id=objective.id,
        objective=objective,
        agent_spec=spec,
        memory_excerpts=[
            MemoryExcerpt(
                id="mem_1",
                type="repo_fact",
                content="Webhook retries live in src/webhooks/retry.py.",
                confidence=0.9,
            ),
            MemoryExcerpt(
                id="mem_2",
                type="repo_fact",
                content="Billing events are in src/billing/events.py.",
                confidence=0.8,
            ),
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
        subprocess.run(["git", *args], check=True, cwd=tmp_path, capture_output=True, text=True)

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
    from bakudo.runner.agent import _extract_report
    from bakudo.runner.result import AgentReport

    class GoodAgent:
        def structured_output(self, model, prompt=None):
            assert model is AgentReport
            assert prompt and "proposed_followups" in prompt  # extraction guidance
            return AgentReport(
                status="success",
                summary="found it",
                proposed_followups=["Approach 1: use a set"],
            )

    out = _extract_report(GoodAgent())
    assert out["proposed_followups"] == ["Approach 1: use a set"]
    assert out["status"] == "success"


def test_extract_report_falls_back_on_failure_and_logs(capsys):
    """Extraction failure must fall back AND say why on stderr — a silent
    swallow cost a live diagnosis (the strands-1.45 tools:[] 400 was invisible
    from outside the guest)."""
    from bakudo.runner.agent import _extract_report

    class BrokenAgent:
        def structured_output(self, model, prompt=None):
            raise RuntimeError("provider exploded")

    assert _extract_report(BrokenAgent(), fallback=None) is None
    err = capsys.readouterr().err
    assert "report extraction failed" in err
    assert "provider exploded" in err


def test_runtime_extra_pins_strands_below_1_45():
    """strands-agents >=1.45 reimplements structured_output via
    beta.chat.completions.parse with `tools: []`, which vLLM rejects (HTTP
    400: '`tools` must not be an empty array') — verified live 2026-08-09
    against 1.44.0 (OK) and 1.45.0/1.50.0/1.51.0 (FAIL). The runtime extra
    must exclude the broken range or every in-guest extraction silently
    falls back."""
    import tomllib

    pyproject = Path(__file__).resolve().parents[1] / "pyproject.toml"
    with open(pyproject, "rb") as fh:
        data = tomllib.load(fh)
    runtime = data["project"]["optional-dependencies"]["runtime"]
    strands = next(r for r in runtime if r.startswith("strands-agents"))
    assert "<1.45" in strands.replace(" ", "")


# --- issue #27: report extraction is the unconditional final phase ---


def _live_run(monkeypatch, tmp_path, fake_agent_cls, spec_name="explore"):
    """Drive build_and_run's live path with a fake strands Agent."""
    import strands

    from bakudo.agent_run_bundle import Budget
    from bakudo.runner.agent import build_and_run
    from bakudo.strands_tools import ToolContext

    # The in-process CLI tests os.environ.setdefault BAKUDO_OFFLINE=1 for the
    # whole test process; the live path must state its posture explicitly.
    monkeypatch.delenv("BAKUDO_OFFLINE", raising=False)
    monkeypatch.setattr(strands, "Agent", fake_agent_cls)
    monkeypatch.setattr("bakudo.runner.agent.build_model", lambda spec: object())
    spec = load_spec_file(AGENTS / f"{spec_name}.yaml")
    objective = Objective(type="explore", repo="bakudo", title="t")
    bundle = AgentRunBundle(
        run_id="run_R",
        objective_id=objective.id,
        objective=objective,
        agent_spec=spec,
        budget=Budget(timeoutSeconds=600),
    )
    ctx = ToolContext(
        workspace=Workspace(tmp_path),
        skills=SkillRegistry(allowed=[]),
        run_id="run_R",
    )
    return build_and_run(spec, bundle, ctx, offline_driver=None), ctx


class _FakeAgentBase:
    """Constructor-compatible with strands.Agent; subclasses set behavior."""

    extracted = None  # AgentReport returned by structured_output, or None to raise

    def __init__(self, *, model=None, system_prompt=None, tools=None, hooks=None):
        self.prompts = []

    def structured_output(self, model, prompt=None):
        self.prompts.append(prompt)
        if self.extracted is None:
            raise RuntimeError("extraction failed")
        return self.extracted


def test_report_extracted_on_budget_halt(monkeypatch, tmp_path):
    """A BudgetExceeded ending must still yield the guided structured-output
    report — status coerced to blocked, halt reason appended, payload kept."""
    import json

    from bakudo.runner.result import AgentReport
    from bakudo.strands_tools import BudgetExceeded

    class FakeAgent(_FakeAgentBase):
        extracted = AgentReport(
            status="success",
            summary="explored half the repo",
            proposed_followups=["Approach 1: use a set"],
        )

        def __call__(self, prompt):
            raise BudgetExceeded("timeout")

    out, ctx = _live_run(monkeypatch, tmp_path, FakeAgent)
    data = json.loads(out)
    assert data["status"] == "blocked"
    assert "budget:timeout" in data["blocked_reasons"]
    assert data["proposed_followups"] == ["Approach 1: use a set"]
    assert ctx.reporting is True  # enforcement was disarmed for extraction


def test_report_extracted_on_denial_halt(monkeypatch, tmp_path):
    import json

    from bakudo.runner.result import AgentReport
    from bakudo.strands_tools import DenialsExhausted

    class FakeAgent(_FakeAgentBase):
        extracted = AgentReport(status="success", summary="hit the policy wall")

        def __call__(self, prompt):
            raise DenialsExhausted(5)

    out, _ = _live_run(monkeypatch, tmp_path, FakeAgent)
    data = json.loads(out)
    assert data["status"] == "blocked"
    assert "denials:circuit_breaker" in data["blocked_reasons"]
    assert data["summary"] == "hit the policy wall"


def test_halted_extraction_failure_falls_back_to_blocked_json(monkeypatch, tmp_path):
    import json

    from bakudo.strands_tools import BudgetExceeded

    class FakeAgent(_FakeAgentBase):
        extracted = None  # structured_output raises

        def __call__(self, prompt):
            raise BudgetExceeded("token_cap")

    out, _ = _live_run(monkeypatch, tmp_path, FakeAgent)
    data = json.loads(out)
    assert data["status"] == "blocked"
    assert "budget:token_cap" in data["blocked_reasons"]


def test_halted_extraction_prompt_names_the_stop(monkeypatch, tmp_path):
    """The extraction prompt for a halted run must tell the model it was
    force-stopped and still carry the followups guidance."""
    from bakudo.runner.result import AgentReport
    from bakudo.strands_tools import BudgetExceeded

    captured = {}

    class FakeAgent(_FakeAgentBase):
        extracted = AgentReport(status="success", summary="s")

        def __call__(self, prompt):
            raise BudgetExceeded("tool_calls")

        def structured_output(self, model, prompt=None):
            captured["prompt"] = prompt
            return super().structured_output(model, prompt)

    _live_run(monkeypatch, tmp_path, FakeAgent)
    assert "stopped" in captured["prompt"].lower()
    assert "proposed_followups" in captured["prompt"]


def test_tool_call_ceiling_wired_from_bundle_budget(tmp_path):
    """bundle.budget.maxToolCalls must land on the ToolContext ceiling."""
    from bakudo.agent_run_bundle import Budget
    from bakudo.runner.agent import build_and_run
    from bakudo.strands_tools import ToolContext

    spec = load_spec_file(AGENTS / "explore.yaml")
    objective = Objective(type="explore", repo="bakudo", title="t")
    bundle = AgentRunBundle(
        run_id="run_C",
        objective_id=objective.id,
        objective=objective,
        agent_spec=spec,
        budget=Budget(timeoutSeconds=600, maxToolCalls=7),
    )
    ctx = ToolContext(
        workspace=Workspace(tmp_path),
        skills=SkillRegistry(allowed=[]),
        run_id="run_C",
    )
    build_and_run(spec, bundle, ctx, offline_driver=lambda s, u, t: "{}")
    assert ctx.tool_call_ceiling == 7


# --- denial circuit-breaker: a policy wall must not become a retry loop ---


def _denying_tools(tmp_path):
    bundle = _bundle()
    ctx = _ctx(bundle, tmp_path)
    tools = build_tool_callables(bundle.agent_spec, ctx)
    return tools, ctx


def test_denial_message_is_instructive(tmp_path):
    tools, ctx = _denying_tools(tmp_path)
    out = tools["run-command"](command="curl http://blocked.example")
    assert out["denied"] is True
    text = out["reason"]
    assert "do not retry" in text.lower()


def test_denials_trip_the_circuit_breaker(tmp_path):
    """Observed live: a read-only scout burned 100+ tool calls retrying
    denied writes (sed/awk workarounds), then wandered within allowed
    commands until wall-clock. After the threshold the *loop* halts —
    the next tool call raises and the run transitions to the report phase
    (issue #27), bounded deterministically rather than by prompt compliance."""
    from bakudo.strands_tools import DenialsExhausted

    tools, ctx = _denying_tools(tmp_path)
    for _ in range(5):
        out = tools["run-command"](command="curl http://blocked.example")
        assert out["denied"] is True
    with pytest.raises(DenialsExhausted):
        tools["run-command"](command="echo hi")  # allowlisted, but too late
    assert len(ctx.denied_commands) == 5  # halt is not itself a denial


def test_build_model_configures_retries_and_connect_timeout(monkeypatch):
    """Transient guest->vLLM ConnectTimeouts killed two live cycles: the
    client must retry more than the SDK default and allow slow connects."""
    pytest.importorskip("strands")
    from bakudo.runner.agent import build_model

    monkeypatch.setenv("VLLM_BASE_URL", "https://llm.example/v1")
    spec = load_spec_file(AGENTS / "optimize-attempt.yaml")
    client_args = build_model(spec).client_args
    assert client_args["max_retries"] >= 5
    assert client_args["timeout"].connect >= 15.0


# --- workspace symlink write guard (SEC-2) ---


def test_workspace_refuses_to_write_through_a_symlink(tmp_path):
    from bakudo.strands_tools.workspace import PathEscape, Workspace

    outside = tmp_path.parent / "outside_secret.txt"
    outside.write_text("original")
    ws = Workspace(tmp_path)
    # A symlink inside the workspace pointing at a file outside it.
    link = tmp_path / "link.txt"
    link.symlink_to(outside)

    with pytest.raises(PathEscape):
        ws.write("link.txt", "pwned")
    assert outside.read_text() == "original", "write must not follow the symlink out"


def test_workspace_still_writes_and_reads_real_files(tmp_path):
    from bakudo.strands_tools.workspace import Workspace

    ws = Workspace(tmp_path)
    ws.write("sub/dir/file.txt", "hello")
    assert ws.read("sub/dir/file.txt") == "hello"
