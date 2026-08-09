"""Synchronous Postgres-backed ledger conforming to :class:`Ledger`.

A single, sync ledger interface (spec sections 14.1, 20) backed by ``psycopg``.
Keeping it synchronous removes the async/sync seam: the same ``Ledger`` Protocol
is used by the in-process pipeline, the meta-agent tools, and the Temporal
activities (which may block on it). ``psycopg`` is imported lazily so the rest
of bakudo imports without the ``db`` extra. The DDL lives in
``infra/postgres/init.sql``.
"""

from __future__ import annotations

import json
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

from ..evals.promotion import PromotionDecision
from ..evals.result import EvalResult
from .records import AgentVersionRecord, RunEvent, RunPhase, RunRecord


class PostgresLedger:
    """A sync ledger over the bakudo tables. Construct via :meth:`connect`.

    Thread safety (TMP-1): activities run concurrently on the worker's thread
    pool, and a single psycopg connection is not thread-safe. In DSN mode
    every ledger call opens a short-lived connection and closes it when done.
    (``psycopg_pool`` is not a project dependency; per-call connections are
    the simple safe default until it is.) An explicit injected connection is
    still supported for tests/tools and is caller-owned — the caller must not
    share the ledger across threads in that mode.
    """

    def __init__(
        self,
        conn: Any = None,
        *,
        dsn: str | None = None,
        connect_kwargs: dict[str, Any] | None = None,
    ) -> None:
        if conn is None and dsn is None:
            raise ValueError("PostgresLedger requires a connection or a DSN")
        self._conn = conn
        self._dsn = dsn
        self._connect_kwargs = connect_kwargs or {}

    @classmethod
    def connect(cls, dsn: str, **kwargs: Any) -> PostgresLedger:
        return cls(dsn=dsn, connect_kwargs=kwargs)

    def close(self) -> None:
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

    @staticmethod
    def _do(conn: Any, sql: str, params: tuple = ()) -> None:
        with conn.cursor() as cur:
            cur.execute(sql, params)

    def _exec(self, sql: str, params: tuple = ()) -> None:
        with self._connection() as conn:
            self._do(conn, sql, params)

    def _one(self, sql: str, params: tuple = ()) -> tuple | None:
        with self._connection() as conn, conn.cursor() as cur:
            cur.execute(sql, params)
            return cur.fetchone()

    def _all(self, sql: str, params: tuple = ()) -> list[tuple]:
        with self._connection() as conn, conn.cursor() as cur:
            cur.execute(sql, params)
            return cur.fetchall()

    # --- agent versions ---
    def upsert_agent_version(self, record: AgentVersionRecord) -> AgentVersionRecord:
        self._exec(
            """
            insert into agent_spec_versions
                (id, name, version, spec_yaml, status, parent_version, created_by, created_at)
            values (%s,%s,%s,%s,%s,%s,%s,%s)
            on conflict (name, version) do update
                set spec_yaml = excluded.spec_yaml, status = excluded.status
            """,
            (record.id, record.name, record.version, record.spec_yaml,
             record.status, record.parent_version, record.created_by, record.created_at),
        )
        return record

    def active_version(self, name: str) -> AgentVersionRecord | None:
        row = self._one(
            """
            select id, name, version, spec_yaml, status, parent_version, created_by, created_at
            from agent_spec_versions
            where name = %s and status = 'active'
            order by version desc limit 1
            """,
            (name,),
        )
        return self._version_row(row)

    def get_agent_version(self, name: str, version: int) -> AgentVersionRecord | None:
        row = self._one(
            """
            select id, name, version, spec_yaml, status, parent_version, created_by, created_at
            from agent_spec_versions where name = %s and version = %s
            """,
            (name, version),
        )
        return self._version_row(row)

    @staticmethod
    def _version_row(row: tuple | None) -> AgentVersionRecord | None:
        if row is None:
            return None
        return AgentVersionRecord(
            id=str(row[0]), name=row[1], version=row[2], spec_yaml=row[3],
            status=row[4], parent_version=row[5], created_by=row[6], created_at=row[7],
        )

    # --- runs ---
    def create_run(self, record: RunRecord, objective: dict | None = None) -> RunRecord:
        """Create the run row, upserting its objective first (TMP-2).

        ``runs.objective_id`` has a FK on ``objectives``; nothing else is
        guaranteed to have inserted the objective, so the upsert happens here,
        idempotently, in the same transaction as the run insert. Without an
        objective document a stub row is written so the FK still holds.
        """
        obj = objective or {}
        with self._connection() as conn, conn.transaction():
            self._do(
                conn,
                """
                insert into objectives (id, repo, type, title, objective_json, status, priority)
                values (%s,%s,%s,%s,%s,%s,%s)
                on conflict (id) do nothing
                """,
                (
                    record.objective_id,
                    obj.get("repo", "unknown"),
                    obj.get("type", "unknown"),
                    obj.get("title", ""),
                    json.dumps(obj),
                    obj.get("status", "ready"),
                    (obj.get("priority") or {}).get("score"),
                ),
            )
            self._do(
                conn,
                """
                insert into runs
                    (id, temporal_workflow_id, abox_task_id, objective_id,
                     agent_ref, status, git_branch, started_at, completed_at)
                values (%s,%s,%s,%s,%s,%s,%s,%s,%s)
                on conflict (id) do nothing
                """,
                (record.id, record.temporal_workflow_id, record.abox_task_id,
                 record.objective_id, record.agent_ref, record.phase.value,
                 record.git_branch, record.started_at, record.completed_at),
            )
            self._append_event(
                conn,
                RunEvent(run_id=record.id, event_type="created", idem_key="created"),
            )
        return record

    def get_run(self, run_id: str) -> RunRecord | None:
        row = self._one(
            """
            select id, temporal_workflow_id, abox_task_id, objective_id,
                   agent_ref, status, git_branch, started_at, completed_at
            from runs where id = %s
            """,
            (run_id,),
        )
        if row is None:
            return None
        return RunRecord(
            id=row[0], temporal_workflow_id=row[1], abox_task_id=row[2],
            objective_id=row[3], agent_ref=row[4], phase=RunPhase(row[5]),
            git_branch=row[6], started_at=row[7], completed_at=row[8],
        )

    def set_phase(self, run_id: str, phase: RunPhase) -> None:
        with self._connection() as conn:
            self._do(conn, "update runs set status = %s where id = %s", (phase.value, run_id))
            self._append_event(
                conn,
                RunEvent(
                    run_id=run_id, event_type="phase",
                    payload={"phase": phase.value},
                    idem_key=f"phase:{phase.value}",
                ),
            )

    def finish_run(self, run_id: str, phase: RunPhase, result: dict | None) -> None:
        with self._connection() as conn:
            self._do(
                conn,
                "update runs set status = %s, completed_at = now() where id = %s",
                (phase.value, run_id),
            )
            self._append_event(
                conn,
                RunEvent(run_id=run_id, event_type="finished",
                         payload={"phase": phase.value, "result": result or {}},
                         idem_key="finished"),
            )

    def _append_event(self, conn: Any, event: RunEvent) -> None:
        # Idempotent under activity retry (TMP-8): identical logical events
        # (same run_id + idem_key) conflict away; NULL keys always append.
        self._do(
            conn,
            """
            insert into run_events (run_id, ts, event_type, payload, idem_key)
            values (%s,%s,%s,%s,%s)
            on conflict (run_id, idem_key) do nothing
            """,
            (event.run_id, event.ts, event.event_type,
             json.dumps(event.payload), event.idem_key),
        )

    def append_event(self, event: RunEvent) -> None:
        with self._connection() as conn:
            self._append_event(conn, event)

    def events(self, run_id: str) -> list[RunEvent]:
        rows = self._all(
            "select run_id, ts, event_type, payload, idem_key "
            "from run_events where run_id = %s order by id",
            (run_id,),
        )
        return [
            RunEvent(
                run_id=r[0], ts=r[1], event_type=r[2],
                payload=r[3] if isinstance(r[3], dict) else json.loads(r[3] or "{}"),
                idem_key=r[4],
            )
            for r in rows
        ]

    # --- evals & promotions ---
    @staticmethod
    def _eval_id(result: EvalResult) -> str:
        """Deterministic id per (subject, suite) so activity retries collide
        instead of duplicating rows (TMP-8)."""
        return str(
            uuid.uuid5(
                uuid.NAMESPACE_URL,
                f"bakudo:eval:{result.subject_type}:{result.subject_id}:{result.suite_name}",
            )
        )

    def record_eval(self, result: EvalResult) -> None:
        self._exec(
            """
            insert into eval_results
                (id, subject_type, subject_id, suite_name, score, passed, details, created_at)
            values (%s,%s,%s,%s,%s,%s,%s, now())
            on conflict (id) do nothing
            """,
            (self._eval_id(result), result.subject_type, result.subject_id,
             result.suite_name, result.score, result.passed, json.dumps(result.details)),
        )

    def eval_results(self, subject_id: str) -> list[EvalResult]:
        rows = self._all(
            "select subject_type, subject_id, suite_name, score, passed, details "
            "from eval_results where subject_id = %s",
            (subject_id,),
        )
        return [
            EvalResult(
                subject_type=r[0], subject_id=r[1], suite_name=r[2],
                score=float(r[3]), passed=r[4],
                details=r[5] if isinstance(r[5], dict) else json.loads(r[5] or "{}"),
            )
            for r in rows
        ]

    def record_promotion(self, decision: PromotionDecision) -> None:
        card = decision.scorecard
        self._exec(
            """
            insert into promotion_decisions
                (id, subject_type, subject_id, decision, rationale, scorecard, created_at)
            values (gen_random_uuid(), %s,%s,%s,%s,%s, now())
            """,
            (card.subject_type, card.subject_id, decision.decision.value,
             decision.rationale, json.dumps(card.model_dump(mode="json"))),
        )
