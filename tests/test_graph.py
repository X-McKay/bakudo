"""FalkorGraphMemory against a scripted fake graph (MEM-9).

The fake records every Cypher query + params and the schema-management calls,
so the adapter's query construction, vecf32 embedding handling, group
namespacing, and idempotent schema creation are exercised without a live
FalkorDB. The live round-trips live in ``tests/test_graph_falkor_live.py``.
"""

from __future__ import annotations

from typing import Any

import pytest

from bakudo.memory.graph import GRAPH_NAME_PREFIX, FalkorGraphMemory, graph_name_for
from bakudo.memory.models import Evidence, MemoryItem


class FakeResult:
    def __init__(self, rows: list[list[Any]]) -> None:
        self.result_set = rows


ALL_CONSTRAINT_KEYS: list[tuple[str, tuple[str, ...]]] = [
    ("Agent", ("name",)),
    ("Run", ("id",)),
    ("Objective", ("id",)),
    ("Skill", ("name",)),
    ("Memory", ("id",)),
    ("FailureMode", ("name",)),
    ("AgentVersion", ("name", "version")),
    ("File", ("repo", "path")),
]


def constraint_listing(status: str = "OPERATIONAL") -> list[dict]:
    return [
        {
            "type": "UNIQUE",
            "label": label,
            "properties": list(props),
            "entitytype": "NODE",
            "status": status,
        }
        for label, props in ALL_CONSTRAINT_KEYS
    ]


def memory_vector_index_row(dim: int) -> list[Any]:
    """The list_indices() row shape a real FalkorDB returns for the Memory
    label (label, properties, types, per-property options, ...)."""
    return [
        "Memory",
        ["id", "embedding"],
        {"id": ["RANGE"], "embedding": ["VECTOR"]},
        {
            "id": {},
            "embedding": {"dimension": dim, "similarityFunction": "cosine"},
        },
        "english",
        [],
        "NODE",
        "OPERATIONAL",
    ]


class FakeFalkorGraph:
    """Records queries and schema calls; answers from canned rows."""

    def __init__(self) -> None:
        self.queries: list[tuple[str, dict | None]] = []
        self.rows: list[list[Any]] = []
        self.unique_constraints: list[tuple[str, tuple[str, ...]]] = []
        self.vector_indexes: list[tuple[str, tuple[str, ...], int, str]] = []
        self.raise_on_constraint: Exception | None = None
        self.raise_on_vector_index: Exception | None = None
        # list_constraints() answers: a sequence consumed one per call
        # (last entry repeats); empty -> derived from unique_constraints,
        # all OPERATIONAL.
        self.constraint_listings: list[list[dict]] = []
        self.constraint_polls = 0
        # list_indices() rows (see memory_vector_index_row).
        self.index_rows: list[list[Any]] = []

    def query(self, q: str, params: dict | None = None) -> FakeResult:
        self.queries.append((q, params))
        return FakeResult(self.rows)

    def create_node_unique_constraint(self, label: str, *properties: str) -> None:
        if self.raise_on_constraint is not None:
            raise self.raise_on_constraint
        self.unique_constraints.append((label, properties))

    def create_node_vector_index(
        self, label: str, *properties: str, dim: int = 0, similarity_function: str = "euclidean"
    ) -> None:
        if self.raise_on_vector_index is not None:
            raise self.raise_on_vector_index
        self.vector_indexes.append((label, properties, dim, similarity_function))

    def list_constraints(self) -> list[dict]:
        self.constraint_polls += 1
        if self.constraint_listings:
            if len(self.constraint_listings) > 1:
                return self.constraint_listings.pop(0)
            return self.constraint_listings[0]
        return [
            {
                "type": "UNIQUE",
                "label": label,
                "properties": list(props),
                "entitytype": "NODE",
                "status": "OPERATIONAL",
            }
            for label, props in self.unique_constraints
        ]

    def list_indices(self) -> FakeResult:
        return FakeResult(self.index_rows)


def make_item(run_id: str | None = "run-1") -> MemoryItem:
    evidence = [Evidence(run_id=run_id)] if run_id else [Evidence(path="src/hooks.py")]
    return MemoryItem(
        type="repo_fact",
        content="webhook delivery retries transient 5xx with backoff",
        scope={"repo": "payments-api"},
        evidence=evidence,
        confidence=0.8,
    )


def make_graph() -> tuple[FalkorGraphMemory, FakeFalkorGraph]:
    fake = FakeFalkorGraph()
    return FalkorGraphMemory(fake), fake


def test_graph_name_is_namespaced_by_group_id() -> None:
    """MEM-16: every group gets its own graph key on the shared FalkorDB."""
    assert graph_name_for("teamA") == f"{GRAPH_NAME_PREFIX}:teamA"
    assert graph_name_for("default") == f"{GRAPH_NAME_PREFIX}:default"


def test_ensure_schema_creates_all_ported_unique_constraints() -> None:
    """The Neo4j init.cypher constraints, ported: six single-property keys
    plus the AgentVersion and File composite keys."""
    graph, fake = make_graph()

    graph.ensure_schema()

    assert set(fake.unique_constraints) == {
        ("Agent", ("name",)),
        ("Run", ("id",)),
        ("Objective", ("id",)),
        ("Skill", ("name",)),
        ("Memory", ("id",)),
        ("FailureMode", ("name",)),
        ("AgentVersion", ("name", "version")),
        ("File", ("repo", "path")),
    }


def test_ensure_schema_parameterizes_vector_dim_from_caller() -> None:
    """MEM-16: no hardcoded 1536 — the dim comes from the wired embedder."""
    graph, fake = make_graph()

    graph.ensure_schema(vector_dim=256)

    assert fake.vector_indexes == [("Memory", ("embedding",), 256, "cosine")]


def test_ensure_schema_skips_vector_index_without_dim() -> None:
    graph, fake = make_graph()
    graph.ensure_schema()
    assert fake.vector_indexes == []


def test_ensure_schema_tolerates_already_existing_schema() -> None:
    """FalkorDB errors on duplicate constraint/index creation; re-running
    ensure_schema (every worker boot) must be a no-op, not a crash."""
    graph, fake = make_graph()
    fake.raise_on_constraint = Exception("Constraint already exists")
    fake.raise_on_vector_index = Exception("Attribute 'embedding' is already indexed")
    fake.constraint_listings = [constraint_listing()]  # already all there

    graph.ensure_schema(vector_dim=256)  # no raise


def test_ensure_schema_reraises_real_errors() -> None:
    graph, fake = make_graph()
    fake.raise_on_constraint = Exception("connection reset")

    with pytest.raises(Exception, match="connection reset"):
        graph.ensure_schema()


def test_ensure_schema_polls_async_constraints_until_operational() -> None:
    """GRAPH.CONSTRAINT CREATE is asynchronous: ensure_schema must not
    return while constraints are still under construction."""
    graph, fake = make_graph()
    fake.constraint_listings = [
        constraint_listing("UNDER CONSTRUCTION"),
        constraint_listing("UNDER CONSTRUCTION"),
        constraint_listing("OPERATIONAL"),
    ]

    graph.ensure_schema()

    assert fake.constraint_polls == 3


def test_ensure_schema_raises_when_a_constraint_failed() -> None:
    """A FAILED async constraint means uniqueness is silently unenforced —
    that must surface, not vanish."""
    graph, fake = make_graph()
    listing = constraint_listing()
    listing[2]["status"] = "FAILED"

    fake.constraint_listings = [listing]

    with pytest.raises(RuntimeError, match="FAILED"):
        graph.ensure_schema()


def test_ensure_schema_times_out_on_stuck_constraints() -> None:
    graph, fake = make_graph()
    fake.constraint_listings = [constraint_listing("UNDER CONSTRUCTION")]

    with pytest.raises(RuntimeError, match="not operational"):
        graph.ensure_schema(constraint_timeout=0.05)


def test_ensure_schema_raises_on_vector_dim_mismatch() -> None:
    """An existing vector index with a different dimension must fail loudly:
    swallowing 'already indexed' would keep the old dim and turn every
    mirror upsert into a poison row."""
    graph, fake = make_graph()
    fake.index_rows = [memory_vector_index_row(dim=256)]

    with pytest.raises(RuntimeError, match="256(.|\\n)*1024"):
        graph.ensure_schema(vector_dim=1024)
    assert fake.vector_indexes == []  # never tried to re-create


def test_ensure_schema_skips_vector_create_when_dim_already_matches() -> None:
    graph, fake = make_graph()
    fake.index_rows = [memory_vector_index_row(dim=256)]

    graph.ensure_schema(vector_dim=256)

    assert fake.vector_indexes == []


def test_ensure_schema_soon_defers_connection_failures_to_the_next_op() -> None:
    """Worker boot must not crash-loop on a graph outage (the outbox exists
    to tolerate exactly that): ensure_schema_soon logs and retries the
    schema before the next graph write instead."""
    graph, fake = make_graph()
    fake.raise_on_constraint = Exception("connection refused")

    graph.ensure_schema_soon(vector_dim=256)  # no raise

    assert fake.unique_constraints == []  # nothing applied yet

    fake.raise_on_constraint = None  # mirror is back
    graph.upsert_memory(run_id="run-1", memory_id="mem-1", memory_type="repo_fact", confidence=0.8)

    assert len(fake.unique_constraints) == 8  # schema applied before the op
    assert fake.vector_indexes == [("Memory", ("embedding",), 256, "cosine")]
    assert len(fake.queries) == 1  # then the upsert itself

    # Once applied, later ops do not re-run the schema.
    graph.remove_memory("mem-1")
    assert len(fake.unique_constraints) == 8


def test_ensure_schema_soon_still_raises_schema_errors() -> None:
    """Only outages are deferred; real schema problems (dim mismatch,
    failed constraints) need an operator and crash the boot loudly."""
    graph, fake = make_graph()
    fake.index_rows = [memory_vector_index_row(dim=256)]

    with pytest.raises(RuntimeError, match="dimension"):
        graph.ensure_schema_soon(vector_dim=1024)


def test_connect_sets_socket_timeouts(monkeypatch: pytest.MonkeyPatch) -> None:
    """redis defaults to unbounded sockets; a partitioned mirror must fail
    fast instead of hanging every write_candidate."""
    import falkordb

    captured: dict[str, Any] = {}

    class FakeDB:
        def select_graph(self, name: str) -> str:
            captured["graph_name"] = name
            return "graph"

    def fake_from_url(url: str, **kwargs: Any) -> FakeDB:
        captured["url"] = url
        captured.update(kwargs)
        return FakeDB()

    monkeypatch.setattr(falkordb.FalkorDB, "from_url", staticmethod(fake_from_url))

    FalkorGraphMemory.connect("falkor://example:6379", group_id="teamA")

    assert captured["url"] == "falkor://example:6379"
    assert captured["graph_name"] == f"{GRAPH_NAME_PREFIX}:teamA"
    assert 0 < captured["socket_connect_timeout"] <= 10
    assert 0 < captured["socket_timeout"] <= 10


def test_upsert_memory_merges_node_and_edge_with_vecf32_embedding() -> None:
    graph, fake = make_graph()

    graph.upsert_memory(
        run_id="run-42",
        memory_id="mem-1",
        memory_type="repo_fact",
        confidence=0.8,
        embedding=[0.1, 0.2],
    )

    (cypher, params) = fake.queries[0]
    assert "merge (r:Run {id: $run_id})" in cypher
    assert "merge (m:Memory {id: $mem_id})" in cypher
    assert "merge (r)-[:PRODUCED_MEMORY]->(m)" in cypher
    # FalkorDB vector indexes only cover vecf32-typed properties.
    assert "m.embedding = vecf32($embedding)" in cypher
    assert params == {
        "run_id": "run-42",
        "mem_id": "mem-1",
        "type": "repo_fact",
        "confidence": 0.8,
        "embedding": [0.1, 0.2],
    }


def test_upsert_memory_without_embedding_never_mentions_vecf32() -> None:
    """FalkorDB has no FOREACH-style conditional set from Neo4j's dialect;
    the query is built without the embedding assignment instead."""
    graph, fake = make_graph()

    graph.upsert_memory(run_id="run-42", memory_id="mem-1", memory_type="repo_fact", confidence=0.8)

    (cypher, params) = fake.queries[0]
    assert "vecf32" not in cypher
    assert "embedding" not in (params or {})


def test_record_memory_edge_delegates_to_upsert() -> None:
    graph, fake = make_graph()
    item = make_item()

    graph.record_memory_edge("run-42", item, embedding=[0.5])

    (cypher, params) = fake.queries[0]
    assert params is not None
    assert params["mem_id"] == item.id
    assert params["type"] == item.type
    assert params["confidence"] == item.confidence
    assert params["embedding"] == [0.5]


def test_remove_memory_detach_deletes_the_node() -> None:
    """MEM-10: supersede must be able to remove the mirrored node."""
    graph, fake = make_graph()

    graph.remove_memory("mem-old")

    (cypher, params) = fake.queries[0]
    assert "match (m:Memory {id: $mem_id})" in cypher
    assert "detach delete m" in cypher
    assert params == {"mem_id": "mem-old"}


def test_record_run_edges_merges_run_agent_objective_and_files() -> None:
    graph, fake = make_graph()

    graph.record_run_edges(
        run_id="run-1",
        agent_name="fixer",
        agent_version=3,
        objective_id="obj-1",
        touched_files=["a.py", "b.py"],
        repo="payments-api",
    )

    (cypher, params) = fake.queries[0]
    assert "merge (r:Run {id: $run_id})" in cypher
    assert "[:USED_AGENT]" in cypher and "[:ATTEMPTED]" in cypher
    assert "unwind $files as path" in cypher
    assert params == {
        "run_id": "run-1",
        "agent_name": "fixer",
        "agent_version": 3,
        "objective_id": "obj-1",
        "files": ["a.py", "b.py"],
        "repo": "payments-api",
    }


def test_skills_for_failure_mode_returns_names() -> None:
    graph, fake = make_graph()
    fake.rows = [["retry-with-backoff"], ["idempotent-writes"]]

    got = graph.skills_for_failure_mode("flaky-webhook", limit=5)

    assert got == ["retry-with-backoff", "idempotent-writes"]
    (cypher, params) = fake.queries[0]
    assert "HELPS_WITH" in cypher
    assert "limit 5" in cypher
    assert params == {"failure_mode": "flaky-webhook"}


def test_runs_touching_files_returns_overlap_dicts() -> None:
    graph, fake = make_graph()
    fake.rows = [["run-9", 2], ["run-3", 1]]

    got = graph.runs_touching_files(["a.py", "b.py"], limit=7)

    assert got == [
        {"run_id": "run-9", "overlap": 2},
        {"run_id": "run-3", "overlap": 1},
    ]
    (cypher, params) = fake.queries[0]
    assert "TOUCHED_FILE" in cypher
    assert "where f.path in $paths" in cypher
    assert "limit 7" in cypher
    assert params == {"paths": ["a.py", "b.py"]}
