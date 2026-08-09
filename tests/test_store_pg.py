"""PgSemanticMemoryStore against a scripted fake connection.

The fake answers each SQL shape the store issues (pgvector probe, exact-content
lookup, nearest-neighbour, retrieval), so the write policy, dedup/supersede
logic, and SQL parameterisation are exercised without a live Postgres.
"""

from __future__ import annotations

import pytest

from bakudo.memory.models import Evidence, MemoryItem
from bakudo.memory.policy import MemoryRejected
from bakudo.memory.store_pg import (
    PgSemanticMemoryStore,
    ttl_to_interval,
    vector_literal,
)


def item_row(item: MemoryItem, similarity: float | None = None) -> tuple:
    row: tuple = (
        item.id,
        item.type,
        item.scope,
        item.content,
        [e.model_dump(mode="json", exclude_none=True) for e in item.evidence],
        item.confidence,
        item.created_by,
    )
    if similarity is not None:
        row = (*row, similarity)
    return row


class FakeCursor:
    def __init__(self, conn: FakeConn) -> None:
        self._conn = conn
        self._rows: list[tuple] = []

    def execute(self, sql: str, params: tuple = ()) -> None:
        if self._conn.fail_on and self._conn.fail_on in sql:
            raise RuntimeError(f"injected failure on: {self._conn.fail_on}")
        self._conn.executed.append((sql, params))
        if self._conn.transactions and self._conn.transactions[-1]["outcome"] is None:
            self._conn.transactions[-1]["stmts"].append(sql)
        self._rows = self._conn.respond(sql)

    def fetchone(self) -> tuple | None:
        return self._rows[0] if self._rows else None

    def fetchall(self) -> list[tuple]:
        return list(self._rows)

    def __enter__(self) -> FakeCursor:
        return self

    def __exit__(self, *exc: object) -> None:
        return None


class FakeTransaction:
    """Records psycopg3-style ``with conn.transaction():`` blocks."""

    def __init__(self, conn: FakeConn) -> None:
        self._conn = conn

    def __enter__(self) -> FakeTransaction:
        self._conn.transactions.append({"stmts": [], "outcome": None})
        return self

    def __exit__(self, exc_type: object, *exc: object) -> None:
        self._conn.transactions[-1]["outcome"] = (
            "rollback" if exc_type is not None else "commit"
        )
        return None


class FakeConn:
    """Answers the store's SQL shapes from canned rows."""

    def __init__(self, *, pgvector_enabled: bool = True) -> None:
        self.executed: list[tuple[str, tuple]] = []
        self.pgvector_enabled = pgvector_enabled
        self.content_rows: list[tuple] = []
        self.nearest_row: tuple | None = None
        self.query_rows: list[tuple] = []
        self.transactions: list[dict] = []
        self.fail_on: str | None = None

    def cursor(self) -> FakeCursor:
        return FakeCursor(self)

    def transaction(self) -> FakeTransaction:
        return FakeTransaction(self)

    def respond(self, sql: str) -> list[tuple]:
        if "pg_extension" in sql:
            return [(1,)] if self.pgvector_enabled else []
        if "lower(trim(content))" in sql:
            return list(self.content_rows)
        if "similarity" in sql and sql.rstrip().endswith("limit 1"):
            return [self.nearest_row] if self.nearest_row is not None else []
        if sql.lstrip().startswith("select"):
            return list(self.query_rows)
        return []

    def statements(self, fragment: str) -> list[tuple[str, tuple]]:
        return [(sql, params) for sql, params in self.executed if fragment in sql]


def make_item(
    content: str = "webhook delivery retries transient 5xx with backoff",
    confidence: float = 0.8,
    run_id: str | None = "run-1",
) -> MemoryItem:
    evidence = [Evidence(run_id=run_id)] if run_id else [Evidence(path="src/hooks.py")]
    return MemoryItem(
        type="repo_fact",
        content=content,
        scope={"repo": "payments-api"},
        evidence=evidence,
        confidence=confidence,
    )


class GraphStub:
    def __init__(self) -> None:
        self.calls: list[tuple[str, MemoryItem, list[float] | None]] = []

    def record_memory_edge(
        self, run_id: str, memory: MemoryItem, embedding: list[float] | None = None
    ) -> None:
        self.calls.append((run_id, memory, embedding))


def make_store(conn: FakeConn, **kwargs) -> PgSemanticMemoryStore:
    return PgSemanticMemoryStore(conn, **kwargs)


def test_missing_pgvector_fails_closed() -> None:
    with pytest.raises(RuntimeError, match="pgvector"):
        make_store(FakeConn(pgvector_enabled=False))


def test_write_inserts_item_and_embedding() -> None:
    conn = FakeConn()
    store = make_store(conn)
    item = make_item()

    stored = store.write_candidate(item)

    assert stored is item
    (item_sql, item_params) = conn.statements("insert into memory_items")[0]
    assert item_params[0] == item.id
    assert item_params[3] == item.content
    (emb_sql, emb_params) = conn.statements("insert into memory_embeddings")[0]
    assert emb_params[0] == item.id
    assert emb_params[1].startswith("[") and emb_params[1].endswith("]")


def test_write_rejects_policy_violation_without_touching_tables() -> None:
    conn = FakeConn()
    store = make_store(conn)
    item = make_item()
    item.evidence = []

    with pytest.raises(MemoryRejected, match="lacks evidence"):
        store.write_candidate(item)
    assert not conn.statements("insert")


def test_write_rejects_exact_repeat_of_confident_memory() -> None:
    conn = FakeConn()
    store = make_store(conn)
    prior = make_item(confidence=0.9)
    conn.content_rows = [item_row(prior)]

    with pytest.raises(MemoryRejected, match="repeats existing"):
        store.write_candidate(make_item(confidence=0.8))


def test_write_rejects_near_duplicate_of_more_confident_memory() -> None:
    conn = FakeConn()
    store = make_store(conn)
    prior = make_item(content="webhook retries any transient 5xx with backoff")
    conn.nearest_row = item_row(prior, similarity=0.97)

    with pytest.raises(MemoryRejected, match="near-duplicate"):
        store.write_candidate(make_item(confidence=prior.confidence))


def test_write_supersedes_less_confident_near_duplicate() -> None:
    conn = FakeConn()
    store = make_store(conn)
    prior = make_item(
        content="webhook retries any transient 5xx with backoff", confidence=0.6
    )
    conn.nearest_row = item_row(prior, similarity=0.97)
    candidate = make_item(confidence=0.9)

    stored = store.write_candidate(candidate)

    assert stored is candidate
    (delete_sql, delete_params) = conn.statements("delete from memory_items")[0]
    assert delete_params == (prior.id,)
    assert conn.statements("insert into memory_items")
    assert conn.statements("insert into memory_embeddings")


def test_distant_neighbour_does_not_block_write() -> None:
    conn = FakeConn()
    store = make_store(conn)
    prior = make_item(content="the CI matrix runs on python 3.11 and 3.12 only")
    conn.nearest_row = item_row(prior, similarity=0.10)

    store.write_candidate(make_item())
    assert not conn.statements("delete from memory_items")
    assert conn.statements("insert into memory_items")


def test_query_by_text_ranks_server_side_and_filters_similarity() -> None:
    conn = FakeConn()
    store = make_store(conn)
    close = make_item(content="webhook delivery retries transient 5xx with backoff")
    far = make_item(content="the CI matrix runs on python 3.11 and 3.12 only")
    conn.query_rows = [item_row(close, 0.92), item_row(far, 0.12)]

    got = store.query(text="webhook retry behaviour", min_similarity=0.5)

    assert [m.id for m in got] == [close.id]
    (sql, params) = conn.statements("<=>")[-1]
    assert "order by e.embedding <=>" in sql


def test_query_without_text_orders_by_confidence_with_scope() -> None:
    conn = FakeConn()
    store = make_store(conn)
    conn.query_rows = [item_row(make_item())]

    got = store.query(scope={"repo": "payments-api"}, limit=5)

    assert len(got) == 1
    (sql, params) = conn.statements("order by confidence desc")[0]
    assert "scope @> %s::jsonb" in sql
    assert params == ('{"repo": "payments-api"}', 5)


def test_write_mirrors_into_graph_with_embedding() -> None:
    conn = FakeConn()
    graph = GraphStub()
    store = make_store(conn, graph=graph)
    item = make_item(run_id="run-42")

    store.write_candidate(item)

    assert len(graph.calls) == 1
    run_id, memory, embedding = graph.calls[0]
    assert run_id == "run-42"
    assert memory is item
    assert embedding is not None and len(embedding) == store.embedder.dim


def test_graph_mirror_skipped_without_run_evidence() -> None:
    conn = FakeConn()
    graph = GraphStub()
    store = make_store(conn, graph=graph)

    store.write_candidate(make_item(run_id=None))
    assert graph.calls == []


def test_insert_writes_item_and_embedding_in_one_transaction() -> None:
    conn = FakeConn()
    store = make_store(conn)

    store.write_candidate(make_item())

    assert len(conn.transactions) == 1
    tx = conn.transactions[0]
    assert tx["outcome"] == "commit"
    assert any("insert into memory_items" in s for s in tx["stmts"])
    assert any("insert into memory_embeddings" in s for s in tx["stmts"])


def test_supersede_delete_and_insert_share_one_transaction() -> None:
    conn = FakeConn()
    store = make_store(conn)
    prior = make_item(
        content="webhook retries any transient 5xx with backoff", confidence=0.6
    )
    conn.nearest_row = item_row(prior, similarity=0.97)

    store.write_candidate(make_item(confidence=0.9))

    assert len(conn.transactions) == 1
    tx = conn.transactions[0]
    assert tx["outcome"] == "commit"
    assert any("delete from memory_items" in s for s in tx["stmts"])
    assert any("insert into memory_items" in s for s in tx["stmts"])
    assert any("insert into memory_embeddings" in s for s in tx["stmts"])


def test_supersede_rolls_back_delete_when_insert_fails() -> None:
    """The old memory must never be destroyed unless the replacement (item +
    embedding) lands in the same transaction (MEM-2)."""
    conn = FakeConn()
    store = make_store(conn)
    prior = make_item(
        content="webhook retries any transient 5xx with backoff", confidence=0.6
    )
    conn.nearest_row = item_row(prior, similarity=0.97)
    conn.fail_on = "insert into memory_embeddings"

    with pytest.raises(RuntimeError, match="injected failure"):
        store.write_candidate(make_item(confidence=0.9))

    tx = conn.transactions[-1]
    assert tx["outcome"] == "rollback"
    assert any("delete from memory_items" in s for s in tx["stmts"])


def test_ttl_to_interval_shorthand() -> None:
    assert ttl_to_interval("180d") == "180 days"
    assert ttl_to_interval("12h") == "12 hours"
    assert ttl_to_interval("2w") == "2 weeks"
    assert ttl_to_interval("30m") == "30 minutes"
    assert ttl_to_interval(None) is None
    # Unrecognised values pass through for Postgres to validate.
    assert ttl_to_interval("3 fortnights") == "3 fortnights"


def test_vector_literal_shape() -> None:
    assert vector_literal([0.0, 1.0, -0.5]) == "[0.0,1.0,-0.5]"


def test_vector_literal_coerces_numpy_style_scalars() -> None:
    """Real pipelines hand back numpy scalars whose repr() is not a plain
    number (e.g. ``np.float32(0.25)``); the literal must coerce via float()."""

    class NumpyStyleScalar:
        def __init__(self, value: float) -> None:
            self._value = value

        def __float__(self) -> float:
            return self._value

        def __repr__(self) -> str:
            return f"np.float32({self._value})"

    literal = vector_literal([NumpyStyleScalar(0.25), NumpyStyleScalar(-1.0)])
    assert literal == "[0.25,-1.0]"
