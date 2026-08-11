"""PgSemanticMemoryStore against a scripted fake connection.

The fake answers each SQL shape the store issues (pgvector probe, exact-content
lookup, nearest-neighbour, retrieval), so the write policy, dedup/supersede
logic, and SQL parameterisation are exercised without a live Postgres.
"""

from __future__ import annotations

from datetime import timedelta

import pytest

from bakudo.memory.models import Evidence, MemoryItem
from bakudo.memory.policy import MemoryRejected
from bakudo.memory.store_pg import (
    PgSemanticMemoryStore,
    interval_to_ttl,
    ttl_to_interval,
    vector_literal,
)


def item_row(
    item: MemoryItem,
    similarity: float | None = None,
    *,
    ttl: timedelta | None = None,
) -> tuple:
    row: tuple = (
        item.id,
        item.type,
        item.scope,
        item.content,
        [e.model_dump(mode="json", exclude_none=True) for e in item.evidence],
        item.confidence,
        ttl,  # psycopg returns interval columns as timedelta
        item.created_by,
    )
    if similarity is not None:
        row = (*row, similarity)
    return row


class FakeCursor:
    def __init__(self, conn: FakeConn) -> None:
        self._conn = conn
        self._rows: list[tuple] = []
        self.rowcount = 0

    def execute(self, sql: str, params: tuple = ()) -> None:
        if self._conn.fail_on and self._conn.fail_on in sql:
            raise RuntimeError(f"injected failure on: {self._conn.fail_on}")
        self._conn.executed.append((sql, params))
        if self._conn.transactions and self._conn.transactions[-1]["outcome"] is None:
            self._conn.transactions[-1]["stmts"].append(sql)
        self._rows = self._conn.respond(sql, params)

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
        # atttypmod of memory_embeddings.embedding: -1 = untyped 'vector',
        # N > 0 = 'vector(N)', None = table missing.
        self.embedding_typmod: int | None = -1
        # ids returned by the purge_expired delete's `returning id`.
        self.purge_ids: list[str] = []
        # A functional graph_mirror_outbox: inserts append, selects list
        # pending rows, deletes/updates act by id — so the outbox drain
        # logic (MEM-3) is exercised for real against the fake.
        self.outbox: list[dict] = []
        self._outbox_seq = 0
        # pg_try_advisory_xact_lock answer for the single-drainer guard.
        self.advisory_lock = True

    def cursor(self) -> FakeCursor:
        return FakeCursor(self)

    def transaction(self) -> FakeTransaction:
        return FakeTransaction(self)

    def _outbox_respond(self, sql: str, params: tuple) -> list[tuple]:
        stripped = sql.lstrip()
        if stripped.startswith("insert"):
            self._outbox_seq += 1
            op, memory_id, run_id, payload = params
            self.outbox.append(
                {
                    "id": self._outbox_seq,
                    "op": op,
                    "memory_id": memory_id,
                    "run_id": run_id,
                    "payload": payload,
                    "attempts": 0,
                    "dead": False,
                }
            )
            return []
        if stripped.startswith("select"):
            return [
                (r["id"], r["op"], r["memory_id"], r["run_id"], r["payload"], r["attempts"])
                for r in self.outbox
                if not r["dead"]
            ]
        if stripped.startswith("delete"):
            self.outbox = [r for r in self.outbox if r["id"] != params[0]]
            return []
        if stripped.startswith("update"):
            for r in self.outbox:
                if r["id"] == params[0]:
                    r["attempts"] += 1
                    if "dead = true" in sql:
                        r["dead"] = True
            return []
        return []

    def respond(self, sql: str, params: tuple = ()) -> list[tuple]:
        if "graph_mirror_outbox" in sql:
            return self._outbox_respond(sql, params)
        if "pg_try_advisory_xact_lock" in sql:
            return [(self.advisory_lock,)]
        if sql.lstrip().startswith("delete") and "created_at + ttl" in sql:
            return [(i,) for i in self.purge_ids]
        if "pg_extension" in sql:
            return [(1,)] if self.pgvector_enabled else []
        if "atttypmod" in sql:
            return [] if self.embedding_typmod is None else [(self.embedding_typmod,)]
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
    """Records mirror ops; can fail the next N upserts (mirror outage) or
    fail specific memory ids forever (poison payloads)."""

    def __init__(self, fail_upserts: int = 0, fail_ids: set[str] | None = None) -> None:
        self.upserts: list[dict] = []
        self.removes: list[str] = []
        self.fail_upserts = fail_upserts
        self.fail_ids = fail_ids or set()

    def upsert_memory(
        self,
        *,
        run_id: str,
        memory_id: str,
        memory_type: str,
        confidence: float,
        embedding: list[float] | None = None,
    ) -> None:
        if memory_id in self.fail_ids:
            raise RuntimeError("poison payload")
        if self.fail_upserts > 0:
            self.fail_upserts -= 1
            raise RuntimeError("mirror down")
        self.upserts.append(
            {
                "run_id": run_id,
                "memory_id": memory_id,
                "memory_type": memory_type,
                "confidence": confidence,
                "embedding": embedding,
            }
        )

    def remove_memory(self, memory_id: str) -> None:
        self.removes.append(memory_id)


def make_store(conn: FakeConn, **kwargs) -> PgSemanticMemoryStore:
    return PgSemanticMemoryStore(conn, **kwargs)


def test_missing_pgvector_fails_closed() -> None:
    with pytest.raises(RuntimeError, match="pgvector"):
        make_store(FakeConn(pgvector_enabled=False))


def test_typed_embedding_column_rejects_mismatched_embedder_dim() -> None:
    """Against the production vector(1024) column, a 256-dim HashingEmbedder
    must fail fast at connect time, not corrupt/fail every write (MEM-4)."""
    conn = FakeConn()
    conn.embedding_typmod = 1024

    with pytest.raises(RuntimeError, match="vector\\(1024\\)"):
        make_store(conn)  # default HashingEmbedder emits 256 dims


def test_typed_embedding_column_accepts_matching_embedder_dim() -> None:
    from bakudo.memory.embeddings import HashingEmbedder

    conn = FakeConn()
    conn.embedding_typmod = 256
    store = make_store(conn, embedder=HashingEmbedder(dim=256))
    assert store.embedder.dim == 256


def test_untyped_embedding_column_skips_dim_guard() -> None:
    conn = FakeConn()
    conn.embedding_typmod = -1  # dev schema: plain 'vector'
    make_store(conn)  # no raise


def test_missing_embeddings_table_skips_dim_guard() -> None:
    conn = FakeConn()
    conn.embedding_typmod = None  # to_regclass -> null, probe returns no row
    make_store(conn)  # no raise


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


def test_repeat_check_is_scoped_to_the_candidate_scope() -> None:
    """The same fact recorded for repo A must not block repo B: scope-filtered
    recall would never return the repo-A row anyway (MEM-11)."""
    conn = FakeConn()
    store = make_store(conn)

    store.write_candidate(make_item())

    (sql, params) = conn.statements("lower(trim(content))")[0]
    assert "scope @> %s::jsonb" in sql
    assert '{"repo": "payments-api"}' in params


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

    assert len(graph.upserts) == 1
    up = graph.upserts[0]
    assert up["run_id"] == "run-42"
    assert up["memory_id"] == item.id
    assert up["memory_type"] == item.type
    assert up["confidence"] == item.confidence
    assert up["embedding"] is not None and len(up["embedding"]) == store.embedder.dim
    # Delivered ops leave no residue to re-deliver.
    assert conn.outbox == []


def test_graph_mirror_skipped_without_run_evidence() -> None:
    conn = FakeConn()
    graph = GraphStub()
    store = make_store(conn, graph=graph)

    store.write_candidate(make_item(run_id=None))
    assert graph.upserts == []
    assert conn.outbox == []


# --- graph-mirror outbox (MEM-3) + supersede removal (MEM-10) ---


def test_mirror_op_is_enqueued_in_the_write_transaction() -> None:
    """MEM-3: the outbox row commits atomically with the memory row, so a
    crash between commit and mirror delivery can never lose the graph write."""
    conn = FakeConn()
    store = make_store(conn, graph=GraphStub())

    store.write_candidate(make_item(run_id="run-42"))

    tx = conn.transactions[0]
    assert any("insert into graph_mirror_outbox" in s for s in tx["stmts"])


def test_no_outbox_rows_without_a_graph_mirror() -> None:
    conn = FakeConn()
    store = make_store(conn)  # graph=None

    store.write_candidate(make_item(run_id="run-42"))

    assert not conn.statements("graph_mirror_outbox")


def test_supersede_removes_the_old_mirrored_node() -> None:
    """MEM-10: superseding a memory must delete its graph node, not leave the
    graph accumulating nodes Postgres already deleted."""
    conn = FakeConn()
    graph = GraphStub()
    store = make_store(conn, graph=graph)
    prior = make_item(
        content="webhook retries any transient 5xx with backoff", confidence=0.6
    )
    conn.nearest_row = item_row(prior, similarity=0.97)
    candidate = make_item(confidence=0.9)

    store.write_candidate(candidate)

    assert graph.removes == [prior.id]
    assert [u["memory_id"] for u in graph.upserts] == [candidate.id]
    # Both ops rode the supersede transaction's outbox.
    tx = conn.transactions[0]
    assert sum("graph_mirror_outbox" in s for s in tx["stmts"]) == 2
    assert conn.outbox == []


def test_mirror_failure_does_not_fail_the_write_and_row_survives() -> None:
    """MEM-3: the durable write already committed; a mirror outage must not
    raise (which would trigger a Temporal retry that gets rejected as a
    repeat). The op stays queued instead."""
    conn = FakeConn()
    graph = GraphStub(fail_upserts=1)
    store = make_store(conn, graph=graph)
    item = make_item(run_id="run-42")

    stored = store.write_candidate(item)  # no raise

    assert stored is item
    assert graph.upserts == []
    assert len(conn.outbox) == 1
    assert conn.outbox[0]["memory_id"] == item.id
    assert conn.outbox[0]["attempts"] == 1


def test_pending_mirror_ops_drain_on_the_next_write() -> None:
    """MEM-3 retry semantics: a later write (e.g. the retried activity's next
    candidate) delivers the backlog — nothing is permanently absent."""
    conn = FakeConn()
    graph = GraphStub(fail_upserts=1)
    store = make_store(conn, graph=graph)
    first = make_item(run_id="run-42")
    store.write_candidate(first)
    assert graph.upserts == []  # mirror was down

    second = make_item(
        content="the CI matrix runs on python 3.11 and 3.12 only", run_id="run-43"
    )
    store.write_candidate(second)

    assert [u["memory_id"] for u in graph.upserts] == [first.id, second.id]
    assert conn.outbox == []


def test_flush_graph_mirror_drains_explicitly_and_reports_count() -> None:
    conn = FakeConn()
    graph = GraphStub(fail_upserts=1)
    store = make_store(conn, graph=graph)
    store.write_candidate(make_item(run_id="run-42"))
    assert len(conn.outbox) == 1

    assert store.flush_graph_mirror() == 1
    assert len(graph.upserts) == 1
    assert conn.outbox == []
    # Nothing left: flushing again is a no-op.
    assert store.flush_graph_mirror() == 0


def test_flush_stops_at_first_failure_preserving_order() -> None:
    conn = FakeConn()
    # Every implicit flush during the two writes fails (3 attempts), plus one
    # more failure for the first explicit flush below.
    graph = GraphStub(fail_upserts=4)
    store = make_store(conn, graph=graph)
    first = make_item(run_id="run-1")
    store.write_candidate(first)
    second = make_item(
        content="the CI matrix runs on python 3.11 and 3.12 only", run_id="run-2"
    )
    store.write_candidate(second)
    assert len(conn.outbox) == 2

    assert store.flush_graph_mirror() == 0  # still failing: stop, keep order
    assert len(conn.outbox) == 2

    assert store.flush_graph_mirror() == 2
    assert [u["memory_id"] for u in graph.upserts] == [first.id, second.id]


def test_flush_graph_mirror_without_graph_is_a_noop() -> None:
    store = make_store(FakeConn())
    assert store.flush_graph_mirror() == 0


def test_supersede_of_unmirrorable_replacement_keeps_the_old_node() -> None:
    """Delete + replacement-upsert must be atomic in intent: when the new
    item carries no run evidence (so it will never be mirrored), the old
    node's delete must be skipped too — otherwise a live memory vanishes
    from the graph entirely."""
    conn = FakeConn()
    graph = GraphStub()
    store = make_store(conn, graph=graph)
    prior = make_item(
        content="webhook retries any transient 5xx with backoff", confidence=0.6
    )
    conn.nearest_row = item_row(prior, similarity=0.97)

    store.write_candidate(make_item(confidence=0.9, run_id=None))

    assert graph.removes == []
    assert graph.upserts == []
    assert conn.outbox == []


def test_poison_row_is_parked_after_max_attempts_and_stops_blocking() -> None:
    """A permanently failing op must not wedge the mirror: after
    mirror_max_attempts failures the row is parked (dead) and ops behind it
    flow again."""
    conn = FakeConn()
    poison = make_item(run_id="run-1")
    graph = GraphStub(fail_ids={poison.id})
    store = make_store(conn, graph=graph)
    store.mirror_max_attempts = 3

    store.write_candidate(poison)  # attempt 1 (post-write flush)
    healthy = make_item(
        content="the CI matrix runs on python 3.11 and 3.12 only", run_id="run-2"
    )
    # Pre-write flush = attempt 2, post-write flush = attempt 3 -> parked,
    # and the healthy op behind it delivers in the same drain.
    store.write_candidate(healthy)

    assert [u["memory_id"] for u in graph.upserts] == [healthy.id]
    [parked] = conn.outbox
    assert parked["memory_id"] == poison.id
    assert parked["dead"] is True
    assert parked["attempts"] == 3

    # Parked rows are never retried: no further attempts, drains are no-ops.
    assert store.flush_graph_mirror() == 0
    assert parked["attempts"] == 3


def test_flush_skips_when_another_drainer_holds_the_lock() -> None:
    """Concurrent drainers must not interleave (a stale upsert re-applied
    after its delete resurrects a zombie node): the advisory lock keeps a
    single drainer at a time, preserving strict op order."""
    conn = FakeConn()
    graph = GraphStub(fail_upserts=1)  # the post-write flush fails: row stays
    store = make_store(conn, graph=graph)
    store.write_candidate(make_item(run_id="run-1"))
    assert len(conn.outbox) == 1

    conn.advisory_lock = False
    assert store.flush_graph_mirror() == 0
    assert len(conn.outbox) == 1
    assert graph.upserts == []

    conn.advisory_lock = True
    assert store.flush_graph_mirror() == 1


def test_flush_drains_inside_a_transaction_holding_the_lock() -> None:
    conn = FakeConn()
    graph = GraphStub(fail_upserts=1)
    store = make_store(conn, graph=graph)
    store.write_candidate(make_item(run_id="run-1"))

    store.flush_graph_mirror()

    # The successful drain (the last lock-guarded transaction) holds the
    # lock acquisition and the row deletion in one transaction.
    tx = [
        t
        for t in conn.transactions
        if any("pg_try_advisory_xact_lock" in s for s in t["stmts"])
    ][-1]
    assert any("delete from graph_mirror_outbox" in s for s in tx["stmts"])


def test_mirror_failures_are_logged_not_silent(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """The no-raise guarantee must not mean no-signal: delivery failures and
    parked rows emit log records so a dead mirror is visible."""
    conn = FakeConn()
    poison = make_item(run_id="run-1")
    graph = GraphStub(fail_ids={poison.id})
    store = make_store(conn, graph=graph)
    store.mirror_max_attempts = 2

    with caplog.at_level("WARNING", logger="bakudo.memory.store_pg"):
        store.write_candidate(poison)  # attempt 1: warning
        store.flush_graph_mirror()  # attempt 2: parked -> error

    warnings = [r for r in caplog.records if r.levelname == "WARNING"]
    errors = [r for r in caplog.records if r.levelname == "ERROR"]
    assert warnings and poison.id in warnings[0].getMessage()
    assert errors and poison.id in errors[0].getMessage()


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


_TTL_LIVE_PREDICATE = "ttl is null or created_at + ttl > now()"


def test_query_by_text_excludes_expired_rows_server_side() -> None:
    conn = FakeConn()
    store = make_store(conn)

    store.query(text="anything")

    (sql, _) = conn.statements("<=>")[-1]
    assert _TTL_LIVE_PREDICATE in sql


def test_query_without_text_excludes_expired_rows_server_side() -> None:
    conn = FakeConn()
    store = make_store(conn)

    store.query(scope={"repo": "payments-api"})

    (sql, _) = conn.statements("order by confidence desc")[0]
    assert _TTL_LIVE_PREDICATE in sql
    assert "scope @> %s::jsonb" in sql


def test_repeat_check_and_dedup_ignore_expired_rows() -> None:
    conn = FakeConn()
    store = make_store(conn)

    store.write_candidate(make_item())

    (repeat_sql, _) = conn.statements("lower(trim(content))")[0]
    assert _TTL_LIVE_PREDICATE in repeat_sql
    (nearest_sql, _) = conn.statements("limit 1")[-1]
    assert _TTL_LIVE_PREDICATE in nearest_sql


def test_query_round_trips_ttl() -> None:
    conn = FakeConn()
    store = make_store(conn)
    item = make_item()
    conn.query_rows = [item_row(item, 0.9, ttl=timedelta(days=180))]

    got = store.query(text="webhook retries")

    assert got[0].ttl == "180d"


def test_purge_expired_deletes_only_expired_rows() -> None:
    conn = FakeConn()
    store = make_store(conn)
    conn.purge_ids = ["m1", "m2", "m3"]

    assert store.purge_expired() == 3

    (sql, _) = conn.statements("delete from memory_items")[0]
    assert "ttl is not null" in sql
    assert "created_at + ttl <= now()" in sql


def test_purge_expired_enqueues_graph_removals_in_the_purge_transaction() -> None:
    """Expired memories must leave the graph too: purging Postgres rows
    without mirror deletes re-opens the MEM-10 accumulation via TTL."""
    conn = FakeConn()
    graph = GraphStub()
    store = make_store(conn, graph=graph)
    conn.purge_ids = ["m-exp-1", "m-exp-2"]

    assert store.purge_expired() == 2

    # Delete ops enqueued atomically with the purge delete.
    tx = next(
        t
        for t in conn.transactions
        if any("created_at + ttl" in s for s in t["stmts"])
    )
    assert sum("graph_mirror_outbox" in s for s in tx["stmts"]) == 2
    assert [(r["op"], r["memory_id"]) for r in conn.outbox] == [
        ("delete", "m-exp-1"),
        ("delete", "m-exp-2"),
    ]
    # The next drain removes the nodes.
    assert store.flush_graph_mirror() == 2
    assert graph.removes == ["m-exp-1", "m-exp-2"]


def test_purge_expired_without_graph_enqueues_nothing() -> None:
    conn = FakeConn()
    store = make_store(conn)
    conn.purge_ids = ["m-exp-1"]

    assert store.purge_expired() == 1
    assert not conn.statements("graph_mirror_outbox")


def test_interval_to_ttl_round_trip() -> None:
    assert interval_to_ttl(None) is None
    assert interval_to_ttl(timedelta(days=180)) == "180d"
    assert interval_to_ttl(timedelta(hours=12)) == "12h"
    assert interval_to_ttl(timedelta(minutes=30)) == "30m"
    # Weeks collapse to days (Postgres stores intervals as days+seconds).
    assert interval_to_ttl(timedelta(weeks=2)) == "14d"
    # Text-mode connections hand back the interval as text; pass it through.
    assert interval_to_ttl("180 days") == "180 days"


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
