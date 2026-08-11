"""Live FalkorGraphMemory round-trips against a real FalkorDB (MEM-9).

The default suite exercises the adapter against a scripted fake; these tests
validate the actual Cypher (vecf32 embeddings, constraints, MERGE/DETACH
DELETE) against a running FalkorDB. They are marked ``live`` and skip unless
``FALKORDB_URL`` is set — default test runs never open a connection. Start a
throwaway server with::

    docker run --rm -d -p 6379:6379 falkordb/falkordb
    FALKORDB_URL=falkor://localhost:6379 python3 -m pytest tests/test_graph_falkor_live.py

The store-level tests drive the real graph through
:class:`PgSemanticMemoryStore`'s outbox using the scripted FakeConn from
``test_store_pg`` in place of Postgres, so the acceptance path — memory
write -> mirrored node exists -> supersede removes it (MEM-10), with outbox
retry on mirror outage (MEM-3) — runs against the real backend.

Each test uses a unique throwaway group graph and deletes it afterwards.
"""

from __future__ import annotations

import os
import uuid
from collections.abc import Iterator

import pytest

from bakudo.memory.graph import FalkorGraphMemory
from bakudo.memory.models import Evidence, MemoryItem
from bakudo.memory.store_pg import PgSemanticMemoryStore
from test_store_pg import FakeConn, item_row

pytestmark = [
    pytest.mark.live,
    pytest.mark.skipif(
        not os.environ.get("FALKORDB_URL"),
        reason="FALKORDB_URL not set; live FalkorDB tests skipped",
    ),
]

_DIM = 256  # matches the dev HashingEmbedder the store-level tests embed with


@pytest.fixture()
def graph() -> Iterator[FalkorGraphMemory]:
    group_id = f"e2e-graph-{uuid.uuid4().hex[:8]}"
    g = FalkorGraphMemory.connect(os.environ["FALKORDB_URL"], group_id=group_id)
    g.ensure_schema(vector_dim=_DIM)
    try:
        yield g
    finally:
        try:
            g._graph.delete()  # cleanup: only this test's graph key
        except Exception:
            pass  # graph key never materialised (no writes)
        g.close()


def _node_ids(graph: FalkorGraphMemory, label: str) -> set[str]:
    result = graph._graph.query(f"match (n:{label}) return n.id")
    return {row[0] for row in result.result_set}


def _item(content: str, confidence: float = 0.8, run_id: str = "run_E2EGRAPH1") -> MemoryItem:
    return MemoryItem(
        type="repo_fact",
        content=content,
        scope={"repo": "e2e-graph"},
        evidence=[Evidence(run_id=run_id)],
        confidence=confidence,
    )


def test_ensure_schema_is_idempotent_and_enforces_uniqueness(
    graph: FalkorGraphMemory,
) -> None:
    graph.ensure_schema(vector_dim=_DIM)  # second run: "already exists" swallowed

    constraints = graph._graph.list_constraints()
    assert all(c["type"] == "UNIQUE" for c in constraints)
    # The eight constraints ported from the retired infra/neo4j/init.cypher.
    assert {(c["label"], tuple(c["properties"])) for c in constraints} == {
        ("Agent", ("name",)),
        ("Run", ("id",)),
        ("Objective", ("id",)),
        ("Skill", ("name",)),
        ("Memory", ("id",)),
        ("FailureMode", ("name",)),
        ("AgentVersion", ("name", "version")),
        ("File", ("repo", "path")),
    }


def test_ensure_schema_rejects_a_changed_vector_dim(graph: FalkorGraphMemory) -> None:
    """An embedder swap across boots must fail loudly, not leave the old
    index dimension silently poisoning every mirror upsert."""
    with pytest.raises(RuntimeError, match="dimension"):
        graph.ensure_schema(vector_dim=_DIM // 2)


def test_memory_edge_round_trip_and_removal(graph: FalkorGraphMemory) -> None:
    item = _item("webhook delivery retries transient 5xx with backoff")
    embedding = [float(i) / _DIM for i in range(_DIM)]

    graph.record_memory_edge("run_E2EGRAPH1", item, embedding=embedding)

    result = graph._graph.query(
        # size() rejects Vectorf32, so the embedding comes back whole and is
        # measured client-side.
        "match (r:Run {id: $run})-[:PRODUCED_MEMORY]->(m:Memory {id: $mem}) "
        "return m.type, m.confidence, m.embedding",
        params={"run": "run_E2EGRAPH1", "mem": item.id},
    )
    [[mem_type, confidence, stored]] = result.result_set
    assert (mem_type, confidence) == ("repo_fact", 0.8)
    assert len(stored) == _DIM

    # Idempotent re-upsert (outbox at-least-once delivery): still one node.
    graph.record_memory_edge("run_E2EGRAPH1", item, embedding=embedding)
    assert _node_ids(graph, "Memory") == {item.id}

    graph.remove_memory(item.id)
    assert _node_ids(graph, "Memory") == set()
    # Removal is idempotent and leaves the Run node alone.
    graph.remove_memory(item.id)
    assert _node_ids(graph, "Run") == {"run_E2EGRAPH1"}


def test_run_edges_and_spec_queries_round_trip(graph: FalkorGraphMemory) -> None:
    graph.record_run_edges(
        run_id="run_A",
        agent_name="fixer",
        agent_version=3,
        objective_id="obj_1",
        touched_files=["src/hooks.py", "src/retry.py"],
        repo="payments-api",
    )
    graph.record_run_edges(
        run_id="run_B",
        agent_name="fixer",
        agent_version=3,
        objective_id="obj_2",
        touched_files=["src/retry.py"],
        repo="payments-api",
    )

    got = graph.runs_touching_files(["src/hooks.py", "src/retry.py"])
    assert got[0] == {"run_id": "run_A", "overlap": 2}
    assert {r["run_id"] for r in got} == {"run_A", "run_B"}

    graph._graph.query(
        "merge (s:Skill {name: 'retry-with-backoff'}) "
        "merge (f:FailureMode {name: 'flaky-webhook'}) "
        "merge (s)-[:HELPS_WITH]->(f)"
    )
    assert graph.skills_for_failure_mode("flaky-webhook") == ["retry-with-backoff"]


# --- acceptance: the store's mirror path against the real backend ---


def _store(graph: FalkorGraphMemory) -> tuple[PgSemanticMemoryStore, FakeConn]:
    conn = FakeConn()
    return PgSemanticMemoryStore(conn, graph=graph), conn


def test_store_write_mirrors_node_and_supersede_removes_it(
    graph: FalkorGraphMemory,
) -> None:
    """The acceptance round-trip: memory write -> mirrored node exists ->
    supersede removes it (MEM-10), all against a real FalkorDB."""
    store, conn = _store(graph)

    old = _item("webhook delivery retries transient 5xx with backoff", 0.6)
    store.write_candidate(old)
    assert _node_ids(graph, "Memory") == {old.id}

    # The fake Postgres reports `old` as the nearest neighbour (cosine 0.97),
    # so this more confident near-duplicate takes the supersede path.
    conn.nearest_row = item_row(old, similarity=0.97)
    new = _item("webhook delivery retries any transient 5xx with backoff", 0.9)
    store.write_candidate(new)

    assert _node_ids(graph, "Memory") == {new.id}
    assert conn.outbox == []  # every mirror op delivered


class _FlakyGraph:
    """Proxies a real FalkorGraphMemory, failing the first N upserts."""

    def __init__(self, real: FalkorGraphMemory, fail_upserts: int) -> None:
        self._real = real
        self.fail_upserts = fail_upserts

    def upsert_memory(self, **kwargs: object) -> None:
        if self.fail_upserts > 0:
            self.fail_upserts -= 1
            raise RuntimeError("mirror down")
        self._real.upsert_memory(**kwargs)  # type: ignore[arg-type]

    def remove_memory(self, memory_id: str) -> None:
        self._real.remove_memory(memory_id)


def test_mirror_outage_is_recovered_from_the_outbox(graph: FalkorGraphMemory) -> None:
    """MEM-3: a mirror outage neither fails the write nor loses the graph op;
    the next write drains the backlog into the real backend."""
    flaky = _FlakyGraph(graph, fail_upserts=1)
    conn = FakeConn()
    store = PgSemanticMemoryStore(conn, graph=flaky)

    first = _item("webhook delivery retries transient 5xx with backoff")
    store.write_candidate(first)  # mirror down: no raise, op queued
    assert _node_ids(graph, "Memory") == set()
    assert len(conn.outbox) == 1

    second = _item("the CI matrix runs on python 3.11 and 3.12 only", run_id="run_E2EGRAPH2")
    store.write_candidate(second)

    assert _node_ids(graph, "Memory") == {first.id, second.id}
    assert conn.outbox == []
