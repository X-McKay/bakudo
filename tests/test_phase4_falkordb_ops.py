"""Phase 4 + FalkorDB: the graph adapter, sandbox admission gate, balanced
JSON recovery, observer dedup, doctor, structured logging, async tools, and
A/B comparison."""

import json
import logging

import pytest

from bakudo.abox import gate
from bakudo.agent_spec import load_spec_file
from bakudo.config import Settings
from bakudo.control import MetaAgentTools
from bakudo.curriculum.observe import fresh_objectives, objective_key
from bakudo.doctor import run_checks
from bakudo.evals.compare import ab_compare
from bakudo.evals.corpus import CaseRun, EvalCase, Expectations
from bakudo.log import JsonFormatter, bound_run
from bakudo.memory.graph import FalkorGraphMemory
from bakudo.memory.models import Evidence, MemoryItem
from bakudo.paths import agents_dir
from bakudo.runner.result import RunResult, _balanced_object, _extract_json_blob

# --- FalkorDB graph adapter ---

class FakeGraph:
    def __init__(self):
        self.queries: list[tuple[str, dict]] = []

    def query(self, cypher, params):
        self.queries.append((cypher, params))


def _memory_item() -> MemoryItem:
    return MemoryItem(
        type="repo_fact",
        content="webhook retries use exponential backoff",
        scope={"repo": "payments-api"},
        evidence=[Evidence(run_id="run_9")],
        confidence=0.9,
    )


def test_falkor_records_memory_edge_without_embedding():
    graph = FakeGraph()
    memory = FalkorGraphMemory(db=object(), graph=graph)
    memory.record_memory_edge("run_9", _memory_item())
    cypher, params = graph.queries[0]
    assert "merge (r:Run {id: $run_id})" in cypher
    assert "PRODUCED_MEMORY" in cypher
    assert "vecf32" not in cypher
    assert params["run_id"] == "run_9" and params["confidence"] == 0.9


def test_falkor_records_embedding_variant():
    graph = FakeGraph()
    memory = FalkorGraphMemory(db=object(), graph=graph)
    memory.record_memory_edge("run_9", _memory_item(), embedding=[0.1, 0.2])
    cypher, params = graph.queries[0]
    assert "m.embedding = vecf32($embedding)" in cypher
    assert params["embedding"] == [0.1, 0.2]


def test_settings_expose_falkordb_not_neo4j():
    envs = {row["env"] for row in Settings.describe()}
    assert "FALKORDB_URL" in envs and "FALKORDB_GRAPH" in envs
    assert not any(env.startswith("NEO4J") for env in envs)
    # The URL can embed credentials, so it must be display-masked.
    assert next(
        row for row in Settings.describe() if row["env"] == "FALKORDB_URL"
    )["secret"]


# --- sandbox admission gate ---

def test_gate_width_defaults_and_env_override(monkeypatch):
    gate.reset_gate()
    monkeypatch.delenv("BAKUDO_SANDBOX_CONCURRENCY", raising=False)
    assert 2 <= gate.gate_width() <= 16

    gate.reset_gate()
    monkeypatch.setenv("BAKUDO_SANDBOX_CONCURRENCY", "3")
    assert gate.gate_width() == 3
    gate.reset_gate()


def test_gate_bounds_concurrency(monkeypatch):
    import threading

    gate.reset_gate()
    monkeypatch.setenv("BAKUDO_SANDBOX_CONCURRENCY", "2")
    active, peak = [0], [0]
    lock = threading.Lock()
    barrier = threading.Barrier(4, timeout=10)

    def work():
        barrier.wait()
        with gate.sandbox_slot():
            with lock:
                active[0] += 1
                peak[0] = max(peak[0], active[0])
            with lock:
                active[0] -= 1

    threads = [threading.Thread(target=work) for _ in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=10)
    assert peak[0] <= 2
    gate.reset_gate()


# --- balanced JSON recovery ---

def test_balanced_object_ignores_braces_in_strings():
    text = 'noise {"summary": "uses } inside", "ok": true} trailing {junk'
    assert json.loads(_balanced_object(text))["ok"] is True


def test_extract_json_blob_takes_first_object_not_greedy_span():
    text = 'a {"status": "success", "summary": "one"} b {"unrelated": 1}'
    blob = _extract_json_blob(text)
    assert blob == {"status": "success", "summary": "one"}


# --- observer cross-cycle dedup ---

def test_fresh_objectives_filters_previously_seen():
    first = [{"type": "maintenance", "title": "Fix TODO in x"}]
    fresh, seen = fresh_objectives(first, [])
    assert fresh == first
    again, seen2 = fresh_objectives(first, seen)
    assert again == [] and seen2 == seen
    new = {"type": "qa", "title": "Cover y"}
    fresh3, seen3 = fresh_objectives([*first, new], seen2)
    assert fresh3 == [new]
    assert objective_key(new) in seen3


# --- doctor ---

def test_doctor_offline_reports_skips_not_failures_for_optional_deps(monkeypatch):
    for row in Settings.describe():
        monkeypatch.delenv(row["env"], raising=False)
    monkeypatch.setenv("BAKUDO_OFFLINE", "1")
    results = {r.name: r for r in run_checks()}
    assert results["config"].status == "ok"
    assert results["sandbox"].status == "ok"
    assert results["postgres"].status == "skip"
    assert results["falkordb"].status == "skip"
    assert results["model-gateway"].status == "skip"


def test_doctor_fails_on_unconfigured_gateway_when_online(monkeypatch):
    for row in Settings.describe():
        monkeypatch.delenv(row["env"], raising=False)
    monkeypatch.setenv("BAKUDO_SANDBOX", "abox")
    results = {r.name: r for r in run_checks()}
    assert results["model-gateway"].status == "fail"


def test_doctor_reports_invalid_config(monkeypatch):
    monkeypatch.setenv("BAKUDO_API_PORT", "nope")
    results = run_checks()
    assert results[0].name == "config" and results[0].status == "fail"


# --- structured logging ---

def test_json_formatter_carries_run_id_and_context():
    record = logging.LogRecord(
        "bakudo.test", logging.INFO, __file__, 1, "run started", None, None
    )
    record.context = {"agent": "explore@1"}
    with bound_run("run_LOG"):
        line = json.loads(JsonFormatter().format(record))
    assert line["message"] == "run started"
    assert line["run_id"] == "run_LOG"
    assert line["agent"] == "explore@1"
    # Outside the block the run id no longer binds.
    line2 = json.loads(JsonFormatter().format(record))
    assert "run_id" not in line2


# --- async tools (the API's 202 path) ---

def test_spawn_agent_run_async_returns_id_then_completes(monkeypatch):
    import time

    monkeypatch.setenv("BAKUDO_OFFLINE", "1")
    tools = MetaAgentTools()
    tools.register_agent_spec(load_spec_file(agents_dir() / "explore.yaml"))
    oid = tools.create_objective(
        {"id": "obj_01HZZZZZZZZZZZZZZZZZZZZZY1", "type": "explore",
         "repo": "bakudo", "title": "async map"}
    )
    run_id = tools.spawn_agent_run_async(oid, "explore")
    assert run_id.startswith("run_")

    deadline = time.monotonic() + 15
    info = tools.query_agent_run(run_id)
    while info["phase"] not in ("completed", "failed") and time.monotonic() < deadline:
        time.sleep(0.05)
        info = tools.query_agent_run(run_id)
    assert info["phase"] == "completed"
    assert info["scorecard"] is not None


# --- A/B comparison ---

def _case(name: str) -> EvalCase:
    from bakudo.curriculum import Objective

    return EvalCase(
        name=name,
        objective=Objective.model_validate(
            {"id": f"obj_01HZZZZZZZZZZZZZZZZZZZZ{name[-2:].upper()}",
             "type": "explore", "repo": "r", "title": name}
        ),
        expect=Expectations(status="success"),
    )


def _case_run(status: str, tokens: int = 1000, runtime: float = 1.0) -> CaseRun:
    return CaseRun(
        result=RunResult.model_validate(
            {"run_id": "run_A", "agent": "a@1", "objective_id": "obj_A",
             "status": status, "summary": "s"}
        ),
        tokens_used=tokens,
        runtime_seconds=runtime,
    )


def test_ab_compare_reports_lift_and_paired_deltas():
    baseline = load_spec_file(agents_dir() / "explore.yaml")
    candidate = baseline.model_copy(
        update={"metadata": baseline.metadata.model_copy(update={"version": 2})}
    )
    cases = [_case("case-a1"), _case("case-b2")]

    def run_fn(spec, objective):
        if spec.metadata.version == 1:
            # Baseline passes only case-a1; cheap.
            status = "success" if objective.title == "case-a1" else "failed"
            return _case_run(status, tokens=1000, runtime=1.0)
        # Candidate passes both; costs more.
        return _case_run("success", tokens=1500, runtime=2.0)

    report = ab_compare(baseline, candidate, cases, run_fn, repetitions=2)
    assert report.baseline_pass_rate == 0.5
    assert report.candidate_pass_rate == 1.0
    assert report.pass_rate_lift_pp == 50.0
    assert report.tokens_delta == 500.0
    assert report.runtime_delta_seconds == 1.0
    per_case = {c.case: c for c in report.per_case}
    assert per_case["case-b2"].lift_pp == 100.0
    assert report.diagnostics == []


def test_ab_compare_surfaces_harness_errors_as_diagnostics():
    baseline = load_spec_file(agents_dir() / "explore.yaml")
    candidate = baseline.model_copy(
        update={"metadata": baseline.metadata.model_copy(update={"version": 2})}
    )

    def run_fn(spec, objective):
        if spec.metadata.version == 2:
            raise RuntimeError("sandbox exploded")
        return _case_run("success")

    report = ab_compare(baseline, candidate, [_case("case-c3")], run_fn, repetitions=1)
    assert report.candidate_pass_rate == 0.0
    assert report.pass_rate_lift_pp == -100.0
    assert report.diagnostics[0].kind == "harness-error"
    assert "sandbox exploded" in report.diagnostics[0].detail


def test_ab_compare_rejects_empty_corpus():
    spec = load_spec_file(agents_dir() / "explore.yaml")
    with pytest.raises(ValueError):
        ab_compare(spec, spec, [], lambda s, o: _case_run("success"))
