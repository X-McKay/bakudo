"""Live PgSemanticMemoryStore round-trips against a real Postgres (MEM-9).

The default suite exercises the store against a scripted FakeConn; these
tests validate the actual SQL against pgvector. They are marked ``live``
and skip unless ``BAKUDO_POSTGRES_DSN`` is set — default test runs never
open a connection. Postgres-only: the graph mirror is disabled
(``graph=None``; the Neo4j mirror is frozen pending the FalkorDB
migration).

Each test writes under a unique throwaway repo scope and deletes its rows
afterwards.
"""

from __future__ import annotations

import os
import uuid
from collections.abc import Iterator

import pytest

from bakudo.memory.embeddings import HashingEmbedder
from bakudo.memory.models import Evidence, MemoryItem
from bakudo.memory.store_pg import PgSemanticMemoryStore

pytestmark = [
    pytest.mark.live,
    pytest.mark.skipif(
        not os.environ.get("BAKUDO_POSTGRES_DSN"),
        reason="BAKUDO_POSTGRES_DSN not set; live Postgres tests skipped",
    ),
]


def _column_dim(dsn: str) -> int:
    """Probe the typed dimension of memory_embeddings.embedding so the dev
    HashingEmbedder can match the schema (untyped dev columns -> 256)."""
    import psycopg

    with psycopg.connect(dsn) as conn, conn.cursor() as cur:
        cur.execute(
            "select atttypmod from pg_attribute "
            "where attrelid = to_regclass('memory_embeddings') "
            "and attname = 'embedding'"
        )
        row = cur.fetchone()
    if row is not None and row[0] is not None and int(row[0]) > 0:
        return int(row[0])
    return 256


@pytest.fixture()
def repo() -> str:
    return f"e2e-mem-{uuid.uuid4().hex[:8]}"


@pytest.fixture()
def store(repo: str) -> Iterator[PgSemanticMemoryStore]:
    dsn = os.environ["BAKUDO_POSTGRES_DSN"]
    st = PgSemanticMemoryStore.connect(
        dsn, embedder=HashingEmbedder(dim=_column_dim(dsn)), graph=None
    )
    try:
        yield st
    finally:
        import json

        with st._conn.cursor() as cur:  # cleanup: only this test's scope
            cur.execute(
                "delete from memory_items where scope @> %s::jsonb",
                (json.dumps({"repo": repo}),),
            )
        st.close()


def _item(
    repo: str,
    content: str = "Webhook delivery retries transient 5xx errors with backoff.",
    confidence: float = 0.8,
    ttl: str | None = None,
) -> MemoryItem:
    return MemoryItem(
        type="repo_fact",
        content=content,
        scope={"repo": repo},
        evidence=[Evidence(run_id="run_E2EMEM1")],
        confidence=confidence,
        ttl=ttl,
    )


def test_write_then_query_by_paraphrase(store: PgSemanticMemoryStore, repo: str) -> None:
    written = store.write_candidate(_item(repo))

    hits = store.query(
        text="webhook retries with backoff for transient 5xx",
        scope={"repo": repo},
        min_similarity=0.3,
    )

    assert [m.id for m in hits] == [written.id]
    assert hits[0].content == written.content
    assert any(e.run_id == "run_E2EMEM1" for e in hits[0].evidence)


def test_supersede_replaces_less_confident_near_duplicate(
    store: PgSemanticMemoryStore, repo: str
) -> None:
    old = store.write_candidate(
        _item(repo, "webhook delivery retries transient 5xx with backoff", 0.6)
    )
    # Same token multiset, different string: embedding-identical (cosine 1.0)
    # but not an exact repeat, so it takes the supersede path.
    new = store.write_candidate(
        _item(repo, "transient 5xx webhook delivery retries with backoff", 0.9)
    )

    remaining = store.query(scope={"repo": repo})
    assert [m.id for m in remaining] == [new.id]
    assert old.id not in {m.id for m in remaining}


def test_expired_rows_are_invisible_and_purgeable(
    store: PgSemanticMemoryStore, repo: str
) -> None:
    expired = store.write_candidate(
        _item(repo, "This ephemeral fact expires immediately after writing.", 0.8, ttl="0m")
    )

    # Server-side TTL filter: never returned by query...
    assert store.query(scope={"repo": repo}) == []
    # ...and it does not block a fresh identical write (repeat-check ignores
    # expired rows).
    fresh = store.write_candidate(
        _item(repo, "This ephemeral fact expires immediately after writing.", 0.8)
    )
    assert fresh.id != expired.id

    # Compaction-time purge deletes the expired row for real.
    assert store.purge_expired() >= 1
    remaining_ids = {m.id for m in store.all() if m.scope.get("repo") == repo}
    assert expired.id not in remaining_ids
    assert fresh.id in remaining_ids


def test_ttl_round_trips_through_the_column(
    store: PgSemanticMemoryStore, repo: str
) -> None:
    store.write_candidate(
        _item(repo, "Facts about the webhook subsystem stay fresh for 180 days.", 0.8, ttl="180d")
    )

    hits = store.query(scope={"repo": repo})
    assert [m.ttl for m in hits] == ["180d"]
