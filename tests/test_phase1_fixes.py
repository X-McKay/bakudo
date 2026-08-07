"""Phase 1 correctness fixes: fail-closed pipeline sandbox, a schema gate that
can fail, the memory read path, meta-agent spec resolution, canary
advancement, activity heartbeating, and wheel-safe seed-spec resolution."""

from pathlib import Path

import pytest

from bakudo.abox.local import local_sandbox
from bakudo.abox.select import resolve_sandbox
from bakudo.agent_spec import load_spec_file
from bakudo.control import MetaAgentTools, run_objective
from bakudo.control.optimize import load_role_spec
from bakudo.curriculum import Objective
from bakudo.evals.promotion import (
    Decision,
    PromotionPolicy,
    evaluate_canary,
)
from bakudo.evals.scorecard import Scorecard
from bakudo.memory.models import Evidence, MemoryItem
from bakudo.memory.retrieval import retrieve_excerpts
from bakudo.memory.semantic import SemanticMemoryStore
from bakudo.memory.store import InMemoryStore
from bakudo.paths import agents_dir
from bakudo.temporal import _impl
from bakudo.temporal.activities import _with_heartbeat
from bakudo.temporal.shared import AgentRunInput, EvalInput

AGENTS = Path(__file__).resolve().parents[1] / "agents"


def _clear_sandbox_env(monkeypatch):
    for var in ("BAKUDO_SANDBOX", "BAKUDO_USE_ABOX", "BAKUDO_ENV", "BAKUDO_OFFLINE"):
        monkeypatch.delenv(var, raising=False)


def _objective(**overrides) -> Objective:
    doc = {
        "id": "obj_01HZZZZZZZZZZZZZZZZZZZZZZ9",
        "type": "explore",
        "repo": "bakudo",
        "title": "map the repo",
        "description": "survey the module layout",
    }
    doc.update(overrides)
    return Objective.model_validate(doc)


def _memory_item(content: str, confidence: float = 0.9) -> MemoryItem:
    return MemoryItem(
        type="repo_fact",
        content=content,
        scope={"repo": "bakudo"},
        evidence=[Evidence(run_id="run_X", path="src/x.py")],
        confidence=confidence,
    )


# --- fail-closed sandbox on the pipeline (CLI/API) path ---

def test_pipeline_fails_closed_without_sandbox_config(monkeypatch):
    _clear_sandbox_env(monkeypatch)
    spec = load_spec_file(AGENTS / "explore.yaml")
    with pytest.raises(RuntimeError, match="BAKUDO_SANDBOX"):
        run_objective(_objective(), spec)


def test_pipeline_accepts_explicit_sandbox(monkeypatch):
    _clear_sandbox_env(monkeypatch)
    monkeypatch.setenv("BAKUDO_OFFLINE", "1")
    spec = load_spec_file(AGENTS / "explore.yaml")
    result = run_objective(_objective(), spec, sandbox=local_sandbox)
    assert result.phase.value in ("completed", "failed")


def test_resolve_sandbox_explicit_wins(monkeypatch):
    _clear_sandbox_env(monkeypatch)
    marker = object()
    assert resolve_sandbox(marker) is marker  # type: ignore[arg-type]


# --- the schema gate can actually fail ---

def test_run_eval_suite_fails_schema_on_invalid_result():
    invalid = {"status": "success"}  # missing required result.json fields
    out = _impl.run_eval_suite(
        EvalInput(
            run_id="run_X",
            objective=_objective().to_dict(),
            result=invalid,
        )
    )
    suites = {r["suite_name"]: r for r in out["eval_results"]}
    assert suites["schema"]["passed"] is False
    assert suites["schema"]["score"] == 0.0


def test_run_eval_suite_passes_schema_on_valid_result():
    valid = {
        "run_id": "run_X",
        "agent": "explore@1",
        "objective_id": "obj_01HZZZZZZZZZZZZZZZZZZZZZZ9",
        "status": "success",
        "summary": "done",
    }
    out = _impl.run_eval_suite(
        EvalInput(run_id="run_X", objective=_objective().to_dict(), result=valid)
    )
    suites = {r["suite_name"]: r for r in out["eval_results"]}
    assert suites["schema"]["passed"] is True


# --- memory read path: excerpts flow into the bundle ---

def test_retrieve_excerpts_semantic_store():
    store = SemanticMemoryStore()
    store.write_candidate(_memory_item("The module layout is documented in README."))
    store.write_candidate(_memory_item("Deployment uses docker compose.", 0.8))
    excerpts = retrieve_excerpts(store, _objective(), limit=2)
    assert len(excerpts) == 2
    assert all(e.content for e in excerpts)


def test_retrieve_excerpts_falls_back_without_text_search():
    store = InMemoryStore()
    store.write_candidate(_memory_item("Confidence-ranked retrieval works."))
    excerpts = retrieve_excerpts(store, _objective())
    assert [e.content for e in excerpts] == ["Confidence-ranked retrieval works."]


def test_retrieve_excerpts_none_store_is_empty():
    assert retrieve_excerpts(None, _objective()) == []


def test_render_bundle_populates_memory_excerpts(monkeypatch):
    store = SemanticMemoryStore()
    store.write_candidate(_memory_item("Repo layout: src/bakudo holds the code."))
    monkeypatch.setattr(_impl.DEPS, "memory", store)
    spec = load_spec_file(AGENTS / "explore.yaml").to_dict()
    bundle = _impl.render_bundle(
        AgentRunInput(
            run_id="run_X", objective=_objective().to_dict(), agent_spec=spec
        )
    )
    assert bundle["memory_excerpts"], "render_bundle must ship retrieved memories"
    assert "src/bakudo" in bundle["memory_excerpts"][0]["content"]


def test_spawn_agent_run_ships_memory_to_bundle(monkeypatch):
    monkeypatch.setenv("BAKUDO_OFFLINE", "1")
    tools = MetaAgentTools()
    tools.register_agent_spec(load_spec_file(AGENTS / "explore.yaml"))
    tools.write_memory_candidate(_memory_item("A fact worth shipping.").to_dict())
    oid = tools.create_objective(_objective().to_dict())
    run_id = tools.spawn_agent_run(oid, "explore")
    assert tools.query_agent_run(run_id)["phase"] == "completed"


# --- meta-agent agent-spec resolution ---

def test_resolve_agent_spec_prefers_suggested_seed():
    spec = _impl.resolve_agent_spec("qa", "explore")
    assert spec is not None and spec["metadata"]["name"] == "qa"


def test_resolve_agent_spec_defaults_by_objective_type():
    spec = _impl.resolve_agent_spec(None, "explore")
    assert spec is not None and spec["metadata"]["name"] == "explore"
    spec = _impl.resolve_agent_spec(None, "optimize")
    assert spec is not None and spec["metadata"]["name"] == "optimize-scout"


def test_resolve_agent_spec_unknown_returns_none():
    assert _impl.resolve_agent_spec("no-such-agent", "explore") is None
    assert _impl.resolve_agent_spec(None, "no-such-type") is None


def test_resolve_agent_spec_prefers_ledger_active_version(monkeypatch):
    from bakudo.registry import InMemoryLedger
    from bakudo.registry.records import AgentVersionRecord

    ledger = InMemoryLedger()
    seed = load_spec_file(AGENTS / "explore.yaml")
    evolved = seed.model_copy(
        update={"metadata": seed.metadata.model_copy(update={"version": 7})}
    )
    from bakudo.agent_spec import dump_yaml

    ledger.upsert_agent_version(
        AgentVersionRecord(
            name="explore", version=7, spec_yaml=dump_yaml(evolved), status="active"
        )
    )
    monkeypatch.setattr(_impl.DEPS, "ledger", ledger)
    spec = _impl.resolve_agent_spec("explore", "explore")
    assert spec is not None and spec["metadata"]["version"] == 7


# --- canary advancement (promotion can now terminate) ---

def _card(score: float = 0.9, *, safety: int = 0, critical: int = 0) -> Scorecard:
    return Scorecard(
        subject_type="run",
        subject_id="run_X",
        overall_score=score,
        suites={"schema": score, "safety": score},
        passed_suites=["schema", "safety"],
        safety_regressions=safety,
        critical_failures=critical,
        cases_total=30,
    )


def test_canary_promotes_after_min_runs():
    policy = PromotionPolicy(canary_min_runs=3)
    decision = evaluate_canary(_card(), [_card(), _card(), _card()], policy=policy)
    assert decision.decision is Decision.promote


def test_canary_keeps_observing_below_min_runs():
    policy = PromotionPolicy(canary_min_runs=3)
    decision = evaluate_canary(_card(), [_card()], policy=policy)
    assert decision.decision is Decision.canary
    assert "1/3" in decision.rationale


def test_canary_rejects_on_safety_regression():
    policy = PromotionPolicy(canary_min_runs=1)
    decision = evaluate_canary(_card(), [_card(safety=1)], policy=policy)
    assert decision.decision is Decision.reject


def test_canary_rejects_on_critical_failure():
    policy = PromotionPolicy(canary_min_runs=1)
    decision = evaluate_canary(_card(), [_card(critical=1)], policy=policy)
    assert decision.decision is Decision.reject


def test_tools_advance_canary_records_promotion():
    tools = MetaAgentTools()
    runs = [_card().model_dump(mode="json") for _ in range(25)]
    out = tools.advance_canary(_card().model_dump(mode="json"), runs)
    assert out["decision"] == "promote"
    assert tools.ledger.promotions()[-1].decision is Decision.promote


# --- activity heartbeat wrapper ---

def test_with_heartbeat_returns_value_and_propagates_errors():
    assert _with_heartbeat(lambda x: x + 1, 41) == 42
    with pytest.raises(ValueError, match="boom"):
        _with_heartbeat(_raise)


def _raise():
    raise ValueError("boom")


# --- wheel-safe seed spec resolution ---

def test_agents_dir_resolves_seed_specs():
    assert (agents_dir() / "explore.yaml").is_file()


def test_load_role_spec_uses_agents_dir():
    spec = load_role_spec("optimize-scout")
    assert spec.metadata.name == "optimize-scout"
