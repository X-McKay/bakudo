"""Durable semantic memory over Postgres/pgvector (spec sections 14.1, 20).

:class:`PgSemanticMemoryStore` is the durable counterpart of
:class:`~bakudo.memory.semantic.SemanticMemoryStore`: the same write policy and
embedding-based dedup/retrieval, but persisted in the ``memory_items`` +
``memory_embeddings`` tables so memories written by one run are retrievable by
later runs across processes. Similarity runs server-side via the pgvector
``<=>`` (cosine distance) operator; the DDL lives in ``infra/postgres/init.sql``.

An optional :class:`~bakudo.memory.graph.FalkorGraphMemory` mirror receives a
``PRODUCED_MEMORY`` edge (with the embedding attached) for every accepted
write, which is what the optional FalkorDB vector index in
``infra/falkordb/README.md`` indexes when an operator enables it.

``psycopg`` is imported lazily so the rest of bakudo imports without the ``db``
extra, mirroring :class:`~bakudo.registry.postgres_ledger.PostgresLedger`.
"""

from __future__ import annotations

import json
import re
from typing import Any

from .embeddings import Embedder, HashingEmbedder
from .graph import FalkorGraphMemory
from .models import MemoryItem
from .policy import MemoryRejected, validate_memory_candidate
from .semantic import DEFAULT_DEDUP_THRESHOLD

_TTL_RE = re.compile(r"^\s*(\d+)\s*([dhwm])\s*$", re.IGNORECASE)
_TTL_UNITS = {"d": "days", "h": "hours", "w": "weeks", "m": "minutes"}

_ITEM_COLUMNS = "id, memory_type, scope, content, evidence, confidence, created_by"


def ttl_to_interval(ttl: str | None) -> str | None:
    """Convert the compact TTL shorthand (``"180d"``) to Postgres interval text.

    Unrecognised values pass through unchanged so Postgres reports them.
    """
    if ttl is None:
        return None
    match = _TTL_RE.match(ttl)
    if match is None:
        return ttl
    return f"{match.group(1)} {_TTL_UNITS[match.group(2).lower()]}"


def vector_literal(embedding: list[float]) -> str:
    """Format an embedding as a pgvector input literal (``[x,y,...]``)."""
    return "[" + ",".join(repr(v) for v in embedding) + "]"


class PgSemanticMemoryStore:
    """A sync, durable semantic memory store. Construct via :meth:`connect`."""

    def __init__(
        self,
        conn: Any,
        *,
        embedder: Embedder | None = None,
        dedup_threshold: float = DEFAULT_DEDUP_THRESHOLD,
        graph: FalkorGraphMemory | None = None,
    ) -> None:
        self._conn = conn
        self.embedder = embedder or HashingEmbedder()
        self.dedup_threshold = dedup_threshold
        self._graph = graph
        self._require_pgvector()

    @classmethod
    def connect(
        cls,
        dsn: str,
        *,
        embedder: Embedder | None = None,
        dedup_threshold: float = DEFAULT_DEDUP_THRESHOLD,
        graph: FalkorGraphMemory | None = None,
        **kwargs: Any,
    ) -> PgSemanticMemoryStore:
        import psycopg  # lazy

        conn = psycopg.connect(dsn, autocommit=True, **kwargs)
        return cls(
            conn, embedder=embedder, dedup_threshold=dedup_threshold, graph=graph
        )

    def close(self) -> None:
        self._conn.close()

    # --- store protocol ---

    def write_candidate(self, item: MemoryItem) -> MemoryItem:
        reasons = validate_memory_candidate(item, self._same_content_items(item))
        if reasons:
            raise MemoryRejected("; ".join(reasons))

        embedding = self.embedder.embed(item.content)
        near = self._nearest(embedding, scope=item.scope)
        if near is not None:
            near_item, similarity = near
            if similarity >= self.dedup_threshold:
                if near_item.confidence >= item.confidence:
                    raise MemoryRejected(
                        "near-duplicate of an equally/more confident memory"
                    )
                self._supersede(near_item.id, item, embedding)
                self._mirror(item, embedding)
                return item

        self._insert(item, embedding)
        self._mirror(item, embedding)
        return item

    def query(
        self,
        *,
        text: str | None = None,
        scope: dict | None = None,
        limit: int = 10,
        min_similarity: float = 0.0,
    ) -> list[MemoryItem]:
        where, params = self._scope_clause(scope)
        if text is None:
            rows = self._all_rows(
                f"select {_ITEM_COLUMNS} from memory_items{where} "
                "order by confidence desc limit %s",
                (*params, limit),
            )
            return [self._item_from_row(row) for row in rows]

        q = vector_literal(self.embedder.embed(text))
        # min_similarity filters server-side BEFORE the limit — otherwise the
        # limit truncates first and the filter silently under-fills the
        # result. The client-side check stays as a belt over fakes/older rows.
        sim_clause = (
            (" and " if where else " where ")
            + "1 - (e.embedding <=> %s::vector) >= %s"
        )
        rows = self._all_rows(
            f"select {_ITEM_COLUMNS}, 1 - (e.embedding <=> %s::vector) as similarity "
            "from memory_items "
            f"join memory_embeddings e on e.memory_id = memory_items.id{where}"
            f"{sim_clause} "
            "order by e.embedding <=> %s::vector limit %s",
            (q, *params, q, min_similarity, q, limit),
        )
        return [
            self._item_from_row(row)
            for row in rows
            if float(row[-1]) >= min_similarity
        ]

    def all(self, *, limit: int = 1000) -> list[MemoryItem]:
        """Every stored item, oldest first, bounded (an unbounded scan over a
        production memory store is an operator footgun)."""
        rows = self._all_rows(
            f"select {_ITEM_COLUMNS} from memory_items order by created_at limit %s",
            (limit,),
        )
        return [self._item_from_row(row) for row in rows]

    # --- internals ---

    def _require_pgvector(self) -> None:
        row = self._one_row(
            "select 1 from pg_extension where extname = 'vector'", ()
        )
        if row is None:
            raise RuntimeError(
                "the pgvector extension is not enabled in this database; run "
                "`create extension vector;` (see infra/postgres/init.sql) — "
                "durable semantic memory requires it."
            )

    def _same_content_items(self, item: MemoryItem) -> list[MemoryItem]:
        """Fetch stored items with identical normalised content.

        The write policy only consults ``existing`` for its exact-repeat check,
        so this is a faithful, bounded stand-in for "all existing memories".
        """
        rows = self._all_rows(
            f"select {_ITEM_COLUMNS} from memory_items "
            "where lower(trim(content)) = lower(trim(%s))",
            (item.content,),
        )
        return [self._item_from_row(row) for row in rows]

    def _nearest(
        self, embedding: list[float], *, scope: dict
    ) -> tuple[MemoryItem, float] | None:
        where, params = self._scope_clause(scope)
        q = vector_literal(embedding)
        row = self._one_row(
            f"select {_ITEM_COLUMNS}, 1 - (e.embedding <=> %s::vector) as similarity "
            "from memory_items "
            f"join memory_embeddings e on e.memory_id = memory_items.id{where} "
            "order by e.embedding <=> %s::vector limit 1",
            (q, *params, q),
        )
        if row is None:
            return None
        return self._item_from_row(row), float(row[-1])

    def _insert(self, item: MemoryItem, embedding: list[float]) -> None:
        self._exec(
            "insert into memory_items "
            "(id, memory_type, scope, content, evidence, confidence, ttl, created_by) "
            "values (%s,%s,%s,%s,%s,%s,%s,%s)",
            (
                item.id,
                item.type,
                json.dumps(item.scope),
                item.content,
                json.dumps([e.model_dump(mode="json", exclude_none=True) for e in item.evidence]),
                item.confidence,
                ttl_to_interval(item.ttl),
                item.created_by,
            ),
        )
        self._exec(
            "insert into memory_embeddings (memory_id, embedding) values (%s, %s::vector)",
            (item.id, vector_literal(embedding)),
        )

    def _supersede(
        self, old_id: str, item: MemoryItem, embedding: list[float]
    ) -> None:
        """Replace a less-confident near-duplicate in place (cascade cleans
        the old embedding row)."""
        self._exec("delete from memory_items where id = %s", (old_id,))
        self._insert(item, embedding)

    def _mirror(self, item: MemoryItem, embedding: list[float]) -> None:
        if self._graph is None:
            return
        run_id = next((e.run_id for e in item.evidence if e.run_id), None)
        if run_id is None:
            return
        self._graph.record_memory_edge(run_id, item, embedding=embedding)

    @staticmethod
    def _scope_clause(scope: dict | None) -> tuple[str, tuple]:
        if not scope:
            return "", ()
        return " where scope @> %s::jsonb", (json.dumps(scope),)

    @staticmethod
    def _item_from_row(row: tuple) -> MemoryItem:
        scope = row[2] if isinstance(row[2], dict) else json.loads(row[2] or "{}")
        evidence = row[4] if isinstance(row[4], list) else json.loads(row[4] or "[]")
        return MemoryItem(
            id=row[0],
            type=row[1],
            scope=scope,
            content=row[3],
            evidence=evidence,
            confidence=float(row[5]),
            created_by=row[6],
        )

    def _exec(self, sql: str, params: tuple) -> None:
        with self._conn.cursor() as cur:
            cur.execute(sql, params)

    def _one_row(self, sql: str, params: tuple) -> tuple | None:
        with self._conn.cursor() as cur:
            cur.execute(sql, params)
            return cur.fetchone()

    def _all_rows(self, sql: str, params: tuple) -> list[tuple]:
        with self._conn.cursor() as cur:
            cur.execute(sql, params)
            return cur.fetchall()
