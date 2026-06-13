"""Async Postgres-backed ledger (spec sections 14.1, 20).

Used by Temporal activities (which are already async). ``asyncpg`` is imported
lazily so the rest of bakudo imports without the ``db`` extra installed. The
DDL this targets lives in ``infra/postgres/init.sql``.
"""

from __future__ import annotations

import json
from typing import Any

from ..evals.result import EvalResult
from .records import AgentVersionRecord, RunEvent, RunPhase, RunRecord


class PostgresLedger:
    """A small async wrapper over the bakudo ledger tables.

    Construct with an ``asyncpg`` pool, or use :meth:`connect`.
    """

    def __init__(self, pool: Any) -> None:
        self._pool = pool

    @classmethod
    async def connect(cls, dsn: str, **kwargs: Any) -> PostgresLedger:
        import asyncpg  # lazy

        pool = await asyncpg.create_pool(dsn, **kwargs)
        return cls(pool)

    async def close(self) -> None:
        await self._pool.close()

    async def upsert_agent_version(self, record: AgentVersionRecord) -> None:
        await self._pool.execute(
            """
            insert into agent_spec_versions
                (id, name, version, spec_yaml, status, parent_version, created_by, created_at)
            values ($1,$2,$3,$4,$5,$6,$7,$8)
            on conflict (name, version) do update
                set spec_yaml = excluded.spec_yaml, status = excluded.status
            """,
            record.id, record.name, record.version, record.spec_yaml,
            record.status, record.parent_version, record.created_by, record.created_at,
        )

    async def create_run(self, record: RunRecord) -> None:
        await self._pool.execute(
            """
            insert into runs
                (id, temporal_workflow_id, abox_task_id, objective_id,
                 agent_ref, status, git_branch, started_at, completed_at)
            values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
            """,
            record.id, record.temporal_workflow_id, record.abox_task_id,
            record.objective_id, record.agent_ref, record.phase.value,
            record.git_branch, record.started_at, record.completed_at,
        )
        await self.append_event(RunEvent(run_id=record.id, event_type="created"))

    async def set_phase(self, run_id: str, phase: RunPhase) -> None:
        await self._pool.execute("update runs set status=$2 where id=$1", run_id, phase.value)
        await self.append_event(
            RunEvent(run_id=run_id, event_type="phase", payload={"phase": phase.value})
        )

    async def finish_run(self, run_id: str, phase: RunPhase, result: dict | None) -> None:
        await self._pool.execute(
            "update runs set status=$2, completed_at=now() where id=$1", run_id, phase.value
        )
        await self.append_event(
            RunEvent(run_id=run_id, event_type="finished",
                     payload={"phase": phase.value, "result": result or {}})
        )

    async def append_event(self, event: RunEvent) -> None:
        await self._pool.execute(
            "insert into run_events (run_id, ts, event_type, payload) values ($1,$2,$3,$4)",
            event.run_id, event.ts, event.event_type, json.dumps(event.payload),
        )

    async def record_eval(self, result: EvalResult) -> None:
        await self._pool.execute(
            """
            insert into eval_results
                (id, subject_type, subject_id, suite_name, score, passed, details, created_at)
            values (gen_random_uuid(), $1,$2,$3,$4,$5,$6, now())
            """,
            result.subject_type, result.subject_id, result.suite_name,
            result.score, result.passed, json.dumps(result.details),
        )
