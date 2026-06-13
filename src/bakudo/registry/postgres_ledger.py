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
from typing import Any

from ..evals.promotion import PromotionDecision
from ..evals.result import EvalResult
from .records import AgentVersionRecord, RunEvent, RunPhase, RunRecord


class PostgresLedger:
    """A sync ledger over the bakudo tables. Construct via :meth:`connect`."""

    def __init__(self, conn: Any) -> None:
        self._conn = conn

    @classmethod
    def connect(cls, dsn: str, **kwargs: Any) -> PostgresLedger:
        import psycopg  # lazy

        conn = psycopg.connect(dsn, autocommit=True, **kwargs)
        return cls(conn)

    def close(self) -> None:
        self._conn.close()

    def _exec(self, sql: str, params: tuple = ()) -> None:
        with self._conn.cursor() as cur:
            cur.execute(sql, params)

    def _one(self, sql: str, params: tuple = ()) -> tuple | None:
        with self._conn.cursor() as cur:
            cur.execute(sql, params)
            return cur.fetchone()

    def _all(self, sql: str, params: tuple = ()) -> list[tuple]:
        with self._conn.cursor() as cur:
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
    def create_run(self, record: RunRecord) -> RunRecord:
        self._exec(
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
        self.append_event(RunEvent(run_id=record.id, event_type="created"))
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
        self._exec("update runs set status = %s where id = %s", (phase.value, run_id))
        self.append_event(
            RunEvent(run_id=run_id, event_type="phase", payload={"phase": phase.value})
        )

    def finish_run(self, run_id: str, phase: RunPhase, result: dict | None) -> None:
        self._exec(
            "update runs set status = %s, completed_at = now() where id = %s",
            (phase.value, run_id),
        )
        self.append_event(
            RunEvent(run_id=run_id, event_type="finished",
                     payload={"phase": phase.value, "result": result or {}})
        )

    def append_event(self, event: RunEvent) -> None:
        self._exec(
            "insert into run_events (run_id, ts, event_type, payload) values (%s,%s,%s,%s)",
            (event.run_id, event.ts, event.event_type, json.dumps(event.payload)),
        )

    def events(self, run_id: str) -> list[RunEvent]:
        rows = self._all(
            "select run_id, ts, event_type, payload from run_events where run_id = %s order by id",
            (run_id,),
        )
        return [
            RunEvent(
                run_id=r[0], ts=r[1], event_type=r[2],
                payload=r[3] if isinstance(r[3], dict) else json.loads(r[3] or "{}"),
            )
            for r in rows
        ]

    # --- evals & promotions ---
    def record_eval(self, result: EvalResult) -> None:
        self._exec(
            """
            insert into eval_results
                (id, subject_type, subject_id, suite_name, score, passed, details, created_at)
            values (gen_random_uuid(), %s,%s,%s,%s,%s,%s, now())
            """,
            (result.subject_type, result.subject_id, result.suite_name,
             result.score, result.passed, json.dumps(result.details)),
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
