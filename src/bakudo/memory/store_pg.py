"""Durable semantic memory over Postgres/pgvector (spec sections 14.1, 20).

:class:`PgSemanticMemoryStore` is the durable counterpart of
:class:`~bakudo.memory.semantic.SemanticMemoryStore`: the same write policy and
embedding-based dedup/retrieval, but persisted in the ``memory_items`` +
``memory_embeddings`` tables so memories written by one run are retrievable by
later runs across processes. Similarity runs server-side via the pgvector
``<=>`` (cosine distance) operator; the DDL lives in ``infra/postgres/init.sql``.

An optional :class:`~bakudo.memory.graph.FalkorGraphMemory` mirror receives a
``PRODUCED_MEMORY`` edge (with the embedding attached) for every accepted
write, which is what the FalkorDB vector index created by
``FalkorGraphMemory.ensure_schema`` indexes. Mirror delivery is outboxed
(MEM-3): each accepted write enqueues its graph op into
``graph_mirror_outbox`` inside the same transaction as the memory row, and
the queue is drained best-effort after commit — a mirror outage never fails
the durable write and never loses the graph op. Superseding a memory
enqueues the removal of the old mirrored node (MEM-10).

``psycopg`` is imported lazily so the rest of bakudo imports without the ``db``
extra, mirroring :class:`~bakudo.registry.postgres_ledger.PostgresLedger`.
"""

from __future__ import annotations

import json
import logging
import re
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import timedelta
from typing import Any

from .embeddings import Embedder, HashingEmbedder
from .graph import FalkorGraphMemory
from .models import MemoryItem
from .policy import MemoryRejected, validate_memory_candidate
from .semantic import DEFAULT_DEDUP_THRESHOLD

_TTL_RE = re.compile(r"^\s*(\d+)\s*([dhwm])\s*$", re.IGNORECASE)
_TTL_UNITS = {"d": "days", "h": "hours", "w": "weeks", "m": "minutes"}

_ITEM_COLUMNS = "id, memory_type, scope, content, evidence, confidence, ttl, created_by"

# A row is live when it has no TTL or its TTL has not elapsed (MEM-5).
_TTL_LIVE = "(ttl is null or created_at + ttl > now())"

logger = logging.getLogger(__name__)

# Advisory-lock key serialising outbox drains: with the worker's activity
# thread pool, multiple threads share one store, and two interleaved drainers
# could re-apply a stale upsert after its delete (zombie node). A single
# drainer at a time preserves strict op order; others simply skip.
_OUTBOX_DRAIN_LOCK = 0x62_6B_6D_69  # "bkmi": bakudo mirror

# After this many delivery failures an outbox row is parked (dead=true) so a
# poison payload cannot wedge the queue head forever. Parked rows are kept
# for operator inspection and never retried automatically.
DEFAULT_MIRROR_MAX_ATTEMPTS = 20

# Self-migration DDL for the graph-mirror outbox. infra/postgres/init.sql is
# the canonical, documented copy (it carries the full commentary and runs at
# first database initialization); this constant MUST match it exactly and
# exists because init.sql never runs against an already-initialized database
# (compose volume upgrade, the live cluster) — without it the first
# graph-backed write would hit UndefinedTable inside the write transaction
# and roll back the durable memory write.
_GRAPH_MIRROR_OUTBOX_DDL = """\
create table if not exists graph_mirror_outbox (
  id bigserial primary key,
  op text not null,                -- upsert | delete
  memory_id text not null,
  run_id text,
  payload jsonb not null default '{}',  -- type, confidence, embedding
  attempts int not null default 0,
  dead boolean not null default false,
  created_at timestamptz not null default now()
)"""


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


def interval_to_ttl(value: Any) -> str | None:
    """Convert a Postgres interval column value back to the TTL shorthand.

    psycopg returns intervals as :class:`datetime.timedelta`. The round trip
    is semantically equal, not textually: Postgres stores days+seconds, so
    ``"2w"`` comes back as ``"14d"``. Text-mode values and shapes we cannot
    map cleanly pass through as their string form.
    """
    if value is None:
        return None
    if isinstance(value, str):
        return value
    if isinstance(value, timedelta):
        if value.microseconds == 0:
            if value.seconds == 0 and value.days:
                return f"{value.days}d"
            if value.seconds % 3600 == 0:
                return f"{value.days * 24 + value.seconds // 3600}h"
            if value.seconds % 60 == 0:
                return f"{value.days * 1440 + value.seconds // 60}m"
    return str(value)


def vector_literal(embedding: list[float]) -> str:
    """Format an embedding as a pgvector input literal (``[x,y,...]``).

    Values are coerced through ``float()`` first: real embedding pipelines
    hand back numpy scalars whose ``repr()`` (``np.float32(0.25)``) is not
    valid pgvector input (MEM-13).
    """
    return "[" + ",".join(repr(float(v)) for v in embedding) + "]"


class PgSemanticMemoryStore:
    """A sync, durable semantic memory store. Construct via :meth:`connect`.

    Thread safety (MEM-17, mirroring :class:`PostgresLedger`'s TMP-1): the
    worker runs activities concurrently on a thread pool, and a single psycopg
    connection is **not** thread-safe. In DSN mode every public call opens a
    short-lived connection (all of that call's statements — including the ones
    inside its transaction — run on that one connection) and closes it when
    done. An explicitly injected connection is still supported for tests/tools
    and is caller-owned: the caller must not share such a store across threads.
    (``psycopg_pool`` is not a project dependency; per-call connections are the
    simple safe default, exactly as the ledger chose.)
    """

    def __init__(
        self,
        conn: Any = None,
        *,
        dsn: str | None = None,
        connect_kwargs: dict[str, Any] | None = None,
        embedder: Embedder | None = None,
        dedup_threshold: float = DEFAULT_DEDUP_THRESHOLD,
        graph: FalkorGraphMemory | None = None,
    ) -> None:
        if conn is None and dsn is None:
            raise ValueError("PgSemanticMemoryStore requires a connection or a DSN")
        self._conn = conn
        self._dsn = dsn
        self._connect_kwargs = connect_kwargs or {}
        self.embedder = embedder or HashingEmbedder()
        self.dedup_threshold = dedup_threshold
        self._graph = graph
        self.mirror_max_attempts = DEFAULT_MIRROR_MAX_ATTEMPTS
        with self._connection() as conn_:
            self._require_pgvector(conn_)
            self._require_embedding_dim(conn_)
            if self._graph is not None:
                self._ensure_outbox_table(conn_)

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
        # DSN mode: no persistent connection is held; each call leases its own
        # (MEM-17). Safe to share the returned store across activity threads.
        return cls(
            dsn=dsn,
            connect_kwargs=kwargs,
            embedder=embedder,
            dedup_threshold=dedup_threshold,
            graph=graph,
        )

    def close(self) -> None:
        # Only an injected connection is owned by the store; DSN-mode
        # connections are opened and closed per call.
        if self._conn is not None:
            self._conn.close()

    @contextmanager
    def _connection(self) -> Iterator[Any]:
        """Yield a connection: the injected one, or a fresh per-call one."""
        if self._conn is not None:
            yield self._conn
            return
        import psycopg  # lazy so bakudo imports without the db extra

        assert self._dsn is not None  # guaranteed by __init__
        conn = psycopg.connect(self._dsn, autocommit=True, **self._connect_kwargs)
        try:
            yield conn
        finally:
            conn.close()

    # --- store protocol ---

    def write_candidate(self, item: MemoryItem) -> MemoryItem:
        with self._connection() as conn:
            # Drain any mirror backlog first (MEM-3): a retried activity whose
            # candidate is now rejected as a repeat still pushes the pending
            # graph ops from its earlier, committed attempt.
            self._flush_mirror_quietly(conn)

            reasons = validate_memory_candidate(
                item, self._same_content_items(conn, item)
            )
            if reasons:
                raise MemoryRejected("; ".join(reasons))

            embedding = self.embedder.embed(item.content)
            near = self._nearest(conn, embedding, scope=item.scope)
            if near is not None:
                near_item, similarity = near
                if similarity >= self.dedup_threshold:
                    if near_item.confidence >= item.confidence:
                        raise MemoryRejected(
                            "near-duplicate of an equally/more confident memory"
                        )
                    self._supersede(conn, near_item.id, item, embedding)
                    self._flush_mirror_quietly(conn)
                    return item

            self._insert(conn, item, embedding)
            self._flush_mirror_quietly(conn)
            return item

    def query(
        self,
        *,
        text: str | None = None,
        scope: dict | None = None,
        limit: int = 10,
        min_similarity: float = 0.0,
    ) -> list[MemoryItem]:
        """Retrieve live memories; TTL-expired rows are filtered server-side."""
        where, params = self._live_where(scope)
        with self._connection() as conn:
            if text is None:
                rows = self._all(
                    conn,
                    f"select {_ITEM_COLUMNS} from memory_items{where} "
                    "order by confidence desc limit %s",
                    (*params, limit),
                )
                return [self._item_from_row(row) for row in rows]

            # The ``min_similarity`` cut happens server-side in the WHERE clause
            # (MEM-18): filtering *after* the LIMIT — as this did — could drop
            # every qualifying row when the nearest ``limit`` rows were all
            # below threshold, returning empty while matches existed past the
            # cut. The Python guard below is a redundant belt (harmless against
            # real PG; it also keeps the scripted-conn tests meaningful).
            q = vector_literal(self.embedder.embed(text))
            rows = self._all(
                conn,
                f"select {_ITEM_COLUMNS}, 1 - (e.embedding <=> %s::vector) as similarity "
                "from memory_items "
                f"join memory_embeddings e on e.memory_id = memory_items.id{where} "
                "and 1 - (e.embedding <=> %s::vector) >= %s "
                "order by e.embedding <=> %s::vector limit %s",
                (q, *params, q, min_similarity, q, limit),
            )
        return [
            self._item_from_row(row)
            for row in rows
            if float(row[-1]) >= min_similarity
        ]

    def all(self) -> list[MemoryItem]:
        """Dump every stored row, including TTL-expired ones (debug/admin
        surface; retrieval paths all filter expiry)."""
        with self._connection() as conn:
            rows = self._all(
                conn,
                f"select {_ITEM_COLUMNS} from memory_items order by created_at",
                (),
            )
        return [self._item_from_row(row) for row in rows]

    def purge_expired(self) -> int:
        """Delete TTL-expired rows (cascade removes their embeddings) and
        return how many were purged. Called from compaction (MEM-5).

        Each purged memory also enqueues a graph-mirror delete in the same
        transaction: the graph must not keep nodes Postgres expired (the
        TTL flavour of MEM-10).
        """
        with self._connection() as conn, conn.transaction():
            rows = self._all(
                conn,
                "delete from memory_items "
                "where ttl is not null and created_at + ttl <= now() "
                "returning id",
                (),
            )
            for (mem_id,) in rows:
                self._enqueue_mirror_remove(conn, mem_id)
        return len(rows)

    def flush_graph_mirror(self, limit: int = 100, *, conn: Any = None) -> int:
        """Drain pending graph-mirror ops from the outbox, oldest first.

        Runs in one transaction under a ``pg_try_advisory_xact_lock`` so at
        most one drainer works at a time — interleaved drainers could
        re-apply a stale upsert after its delete and resurrect a superseded
        node; a second caller simply returns 0. Applies each op to the graph
        and deletes its row on success; on a failure the row's ``attempts``
        is bumped and draining stops (preserving op order), except that a
        row failing for the ``mirror_max_attempts``-th time is parked
        (``dead = true``, kept for operator inspection, never retried) so a
        poison payload cannot wedge the queue head forever. Both graph ops
        are idempotent (MERGE / MATCH-delete), so at-least-once delivery is
        safe. Returns the number of ops delivered. Called opportunistically
        on every write and from compaction (MEM-3).

        ``conn`` lets an in-progress public call drain on its own leased
        connection; external callers omit it and get a fresh one.
        """
        if self._graph is None:
            return 0
        if conn is None:
            with self._connection() as leased:
                return self._flush_graph_mirror(leased, limit)
        return self._flush_graph_mirror(conn, limit)

    def _flush_graph_mirror(self, conn: Any, limit: int) -> int:
        assert self._graph is not None
        pending = self._one(
            conn, "select 1 from graph_mirror_outbox where not dead limit 1", ()
        )
        if pending is None:
            return 0
        delivered = 0
        with conn.transaction():
            lock = self._one(
                conn, "select pg_try_advisory_xact_lock(%s)", (_OUTBOX_DRAIN_LOCK,)
            )
            if lock is None or not lock[0]:
                return 0  # another drainer is at it; strict order preserved
            rows = self._all(
                conn,
                "select id, op, memory_id, run_id, payload, attempts "
                "from graph_mirror_outbox where not dead order by id limit %s",
                (limit,),
            )
            for row_id, op, memory_id, run_id, payload, attempts in rows:
                data = (
                    payload if isinstance(payload, dict) else json.loads(payload or "{}")
                )
                try:
                    if op == "delete":
                        self._graph.remove_memory(memory_id)
                    else:
                        self._graph.upsert_memory(
                            run_id=run_id,
                            memory_id=memory_id,
                            memory_type=data.get("type", ""),
                            confidence=float(data.get("confidence", 0.0)),
                            embedding=data.get("embedding"),
                        )
                except Exception as exc:
                    if int(attempts) + 1 >= self.mirror_max_attempts:
                        logger.error(
                            "graph mirror op parked as dead after %d failed "
                            "attempts (outbox row %s, op=%s, memory_id=%s): %s",
                            int(attempts) + 1, row_id, op, memory_id, exc,
                        )
                        self._do(
                            conn,
                            "update graph_mirror_outbox "
                            "set attempts = attempts + 1, dead = true "
                            "where id = %s",
                            (row_id,),
                        )
                        continue  # parked: ops behind it may flow
                    logger.warning(
                        "graph mirror delivery failed (outbox row %s, op=%s, "
                        "memory_id=%s, attempt %d/%d); op stays queued: %s",
                        row_id, op, memory_id, int(attempts) + 1,
                        self.mirror_max_attempts, exc,
                    )
                    self._do(
                        conn,
                        "update graph_mirror_outbox set attempts = attempts + 1 "
                        "where id = %s",
                        (row_id,),
                    )
                    break
                self._do(
                    conn, "delete from graph_mirror_outbox where id = %s", (row_id,)
                )
                delivered += 1
        return delivered

    # --- internals ---

    def _require_pgvector(self, conn: Any) -> None:
        row = self._one(
            conn, "select 1 from pg_extension where extname = 'vector'", ()
        )
        if row is None:
            raise RuntimeError(
                "the pgvector extension is not enabled in this database; run "
                "`create extension vector;` (see infra/postgres/init.sql) — "
                "durable semantic memory requires it."
            )

    def _require_embedding_dim(self, conn: Any) -> None:
        """Fail fast when the embedder's dimension cannot fit the schema.

        The production schema types ``memory_embeddings.embedding`` as
        ``vector(1024)`` (Qwen/Qwen3-Embedding-0.6B); pgvector stores the
        dimension in the column's ``atttypmod``. A mis-dimensioned embedder
        would otherwise fail (or mix dimensions) on every write and query,
        so we reject it at connect time (MEM-4). Consequence, by design: the
        256-dim :class:`HashingEmbedder` dev fallback cannot be used against
        the typed production schema.

        Untyped dev columns (typmod ``-1``) and a not-yet-created table skip
        the check — there is no server-side dimension to enforce yet.
        """
        row = self._one(
            conn,
            "select atttypmod from pg_attribute "
            "where attrelid = to_regclass('memory_embeddings') "
            "and attname = 'embedding'",
            (),
        )
        if row is None:
            return
        typmod = row[0]
        if typmod is None or int(typmod) <= 0:
            return
        if int(typmod) != self.embedder.dim:
            raise RuntimeError(
                f"memory_embeddings.embedding is vector({int(typmod)}) but the "
                f"configured embedder ({type(self.embedder).__name__}) emits "
                f"{self.embedder.dim}-dim vectors; configure an embedder matching "
                "the schema (production: OpenAIEmbedder with "
                "Qwen/Qwen3-Embedding-0.6B, 1024 dims). The 256-dim "
                "HashingEmbedder is a dev/test fallback and cannot write to the "
                "typed production schema."
            )

    def _ensure_outbox_table(self, conn: Any) -> None:
        """Self-migrate the graph-mirror outbox (idempotent).

        Runs only when a graph mirror is wired — an unwired store never
        touches the database shape. The ``add column`` covers databases that
        were initialized with the pre-dead-letter outbox revision.
        """
        self._do(conn, _GRAPH_MIRROR_OUTBOX_DDL, ())
        self._do(
            conn,
            "alter table graph_mirror_outbox "
            "add column if not exists dead boolean not null default false",
            (),
        )

    def _same_content_items(self, conn: Any, item: MemoryItem) -> list[MemoryItem]:
        """Fetch stored items with identical normalised content.

        The write policy only consults ``existing`` for its exact-repeat check,
        so this is a faithful, bounded stand-in for "all existing memories".
        Scoped to the candidate's scope (MEM-11): the same fact recorded for a
        different repo must not block this one — scope-filtered recall would
        never return the other row anyway. Expired rows are ignored (MEM-5).
        """
        where, params = self._live_where(item.scope)
        rows = self._all(
            conn,
            f"select {_ITEM_COLUMNS} from memory_items"
            f"{where} and lower(trim(content)) = lower(trim(%s))",
            (*params, item.content),
        )
        return [self._item_from_row(row) for row in rows]

    def _nearest(
        self, conn: Any, embedding: list[float], *, scope: dict
    ) -> tuple[MemoryItem, float] | None:
        where, params = self._live_where(scope)
        q = vector_literal(embedding)
        row = self._one(
            conn,
            f"select {_ITEM_COLUMNS}, 1 - (e.embedding <=> %s::vector) as similarity "
            "from memory_items "
            f"join memory_embeddings e on e.memory_id = memory_items.id{where} "
            "order by e.embedding <=> %s::vector limit 1",
            (q, *params, q),
        )
        if row is None:
            return None
        return self._item_from_row(row), float(row[-1])

    def _insert(self, conn: Any, item: MemoryItem, embedding: list[float]) -> None:
        """Insert item + embedding atomically: a split write leaves a zombie
        row that blocks re-writes forever (MEM-2). The graph-mirror op is
        enqueued in the same transaction (MEM-3)."""
        with conn.transaction():
            self._insert_rows(conn, item, embedding)
            self._enqueue_mirror_upsert(conn, item, embedding)

    def _insert_rows(self, conn: Any, item: MemoryItem, embedding: list[float]) -> None:
        self._do(
            conn,
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
        self._do(
            conn,
            "insert into memory_embeddings (memory_id, embedding) values (%s, %s::vector)",
            (item.id, vector_literal(embedding)),
        )

    def _supersede(
        self, conn: Any, old_id: str, item: MemoryItem, embedding: list[float]
    ) -> None:
        """Replace a less-confident near-duplicate in place (cascade cleans
        the old embedding row).

        Delete + replacement insert run in one transaction: the old memory is
        never destroyed unless the new item and its embedding both land
        (MEM-2). The superseded node's graph delete is **always** enqueued
        (MEM-19): the old memory row is gone, so leaving its mirrored node
        behind would orphan a graph node pointing at a deleted row — and the
        delete is idempotent, harmless even if the node was never mirrored.
        The replacement's upsert is conditional on run evidence (a memory with
        no run cannot hang a ``PRODUCED_MEMORY`` edge and is not mirrored by
        design); both ops ride the same transaction's outbox (MEM-3).
        """
        with conn.transaction():
            self._do(conn, "delete from memory_items where id = %s", (old_id,))
            self._insert_rows(conn, item, embedding)
            self._enqueue_mirror_remove(conn, old_id)
            if self._mirror_run_id(item) is not None:
                self._enqueue_mirror_upsert(conn, item, embedding)

    def _mirror_run_id(self, item: MemoryItem) -> str | None:
        """The run to hang the mirror edge off — None means "not mirrored"
        (no graph configured, or the item carries no run evidence)."""
        if self._graph is None:
            return None
        return next((e.run_id for e in item.evidence if e.run_id), None)

    def _enqueue_mirror_upsert(
        self, conn: Any, item: MemoryItem, embedding: list[float]
    ) -> None:
        run_id = self._mirror_run_id(item)
        if run_id is None:
            return
        payload = {
            "type": item.type,
            "confidence": item.confidence,
            "embedding": [float(v) for v in embedding],
        }
        self._do(
            conn,
            "insert into graph_mirror_outbox (op, memory_id, run_id, payload) "
            "values (%s, %s, %s, %s)",
            ("upsert", item.id, run_id, json.dumps(payload)),
        )

    def _enqueue_mirror_remove(self, conn: Any, memory_id: str) -> None:
        if self._graph is None:
            return
        self._do(
            conn,
            "insert into graph_mirror_outbox (op, memory_id, run_id, payload) "
            "values (%s, %s, %s, %s)",
            ("delete", memory_id, None, json.dumps({})),
        )

    def _flush_mirror_quietly(self, conn: Any) -> None:
        """Best-effort drain: mirror delivery must never fail the durable
        write path — undelivered ops stay queued for the next drain.
        Per-op failures are logged inside :meth:`flush_graph_mirror`; this
        guard logs drain-machinery failures (e.g. the outbox query itself)
        so a dead mirror is never silent."""
        try:
            self.flush_graph_mirror(conn=conn)
        except Exception:
            logger.warning(
                "graph-mirror drain failed; pending ops stay queued in "
                "graph_mirror_outbox",
                exc_info=True,
            )

    @staticmethod
    def _scope_clause(scope: dict | None) -> tuple[str, tuple]:
        if not scope:
            return "", ()
        return " where scope @> %s::jsonb", (json.dumps(scope),)

    @classmethod
    def _live_where(cls, scope: dict | None) -> tuple[str, tuple]:
        """Scope filter plus the TTL-liveness predicate (MEM-5)."""
        where, params = cls._scope_clause(scope)
        if where:
            return f"{where} and {_TTL_LIVE}", params
        return f" where {_TTL_LIVE}", params

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
            ttl=interval_to_ttl(row[6]),
            created_by=row[7],
        )

    @staticmethod
    def _do(conn: Any, sql: str, params: tuple) -> None:
        with conn.cursor() as cur:
            cur.execute(sql, params)

    @staticmethod
    def _one(conn: Any, sql: str, params: tuple) -> tuple | None:
        with conn.cursor() as cur:
            cur.execute(sql, params)
            return cur.fetchone()

    @staticmethod
    def _all(conn: Any, sql: str, params: tuple) -> list[tuple]:
        with conn.cursor() as cur:
            cur.execute(sql, params)
            return cur.fetchall()
