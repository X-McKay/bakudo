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
from ..trials.models import HackFlags, TrialRecord
from .records import AgentVersionRecord, RunEvent, RunPhase, RunRecord

# Self-migration DDL for the trials table. infra/postgres/init.sql is the
# canonical, documented copy (runs at first database initialization); this
# constant MUST match it exactly and exists because init.sql never runs
# against an already-initialized database (compose volume upgrade, the live
# cluster) — without it the first trial write would hit UndefinedTable.
# Mirrors _GRAPH_MIRROR_OUTBOX_DDL in src/bakudo/memory/store_pg.py.
_TRIALS_DDL = """\
create table if not exists trials (
  id text primary key,
  experiment_id text,
  run_id text,
  objective_id text,
  agent_ref text not null,
  scenario_name text not null,
  scenario_version integer not null,
  scenario_digest text not null,
  seed bigint not null,
  pins jsonb not null default '{}'::jsonb,
  metrics jsonb not null default '{}'::jsonb,
  evaluation jsonb not null default '{}'::jsonb,
  flags jsonb not null default '{}'::jsonb,
  status text not null,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now()
)"""

_TRIALS_EXPERIMENT_INDEX_DDL = (
    "create index if not exists trials_experiment_idx on trials (experiment_id)"
)

# Self-migration DDL for the experiments table. Same rationale as
# _TRIALS_DDL above; infra/postgres/init.sql is the canonical, documented
# copy and this constant MUST match it exactly. Applied lazily in
# record_experiment, so a read (get_experiment/update_experiment_result)
# against a legacy database that predates this table — one that has never
# had record_experiment called on it — raises psycopg.errors.UndefinedTable
# rather than silently creating the table; this mirrors the accepted trials
# pattern (Task 6) rather than being an oversight.
_EXPERIMENTS_DDL = """\
create table if not exists experiments (
  id text primary key,
  name text not null,
  spec jsonb not null,
  status text not null,
  result jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
)"""


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

    @staticmethod
    def _do_one(conn: Any, sql: str, params: tuple = ()) -> tuple | None:
        """execute + fetchone on an already-open connection (for statements
        inside a caller-held transaction)."""
        with conn.cursor() as cur:
            cur.execute(sql, params)
            return cur.fetchone()

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
    _VERSION_COLUMNS = (
        "id, name, version, spec_yaml, status, status_reason, decided_at, "
        "parent_version, created_by, created_at"
    )

    def upsert_agent_version(self, record: AgentVersionRecord) -> AgentVersionRecord:
        with self._connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "select 1 from agent_spec_versions where name = %s limit 1",
                    (record.name,),
                )
                first_of_name = cur.fetchone() is None
            if first_of_name and record.status != "active":
                # Design §1: the first version registered for a name activates.
                record = record.model_copy(
                    update={
                        "status": "active",
                        "status_reason": "first version registered for name",
                    }
                )
            self._do(
                conn,
                """
                insert into agent_spec_versions
                    (id, name, version, spec_yaml, status, status_reason, decided_at,
                     parent_version, created_by, created_at)
                values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                on conflict (name, version) do update
                    set spec_yaml = excluded.spec_yaml, status = excluded.status,
                        status_reason = excluded.status_reason,
                        decided_at = excluded.decided_at
                """,
                (record.id, record.name, record.version, record.spec_yaml,
                 record.status, record.status_reason, record.decided_at,
                 record.parent_version, record.created_by, record.created_at),
            )
        return record

    def _latest_with_status(self, name: str, status: str) -> AgentVersionRecord | None:
        # `status` is interpolated from a fixed internal vocabulary, never
        # caller input.
        assert status in ("active", "canary")
        row = self._one(
            f"""
            select {self._VERSION_COLUMNS}
            from agent_spec_versions
            where name = %s and status = '{status}'
            order by version desc limit 1
            """,
            (name,),
        )
        return self._version_row(row)

    def active_version(self, name: str) -> AgentVersionRecord | None:
        return self._latest_with_status(name, "active")

    def canary_version(self, name: str) -> AgentVersionRecord | None:
        return self._latest_with_status(name, "canary")

    def get_agent_version(self, name: str, version: int) -> AgentVersionRecord | None:
        row = self._one(
            f"""
            select {self._VERSION_COLUMNS}
            from agent_spec_versions where name = %s and version = %s
            """,
            (name, version),
        )
        return self._version_row(row)

    def set_version_status(
        self,
        name: str,
        version: int,
        status: str,
        *,
        reason: str | None = None,
        expected_status: str | None = None,
    ) -> AgentVersionRecord | None:
        """Transition a version through the §1 state machine.

        The transition and its event are one ledger write: the row update and
        the outbox event (topic ``agent_version_status``, spec section 17.1)
        share a transaction. ``expected_status`` guards a compare-and-set
        (TMP-23): the transition applies only if the version is currently in
        that status, else it is a no-op returning ``None``.
        """
        from .records import VERSION_STATUSES

        if status not in VERSION_STATUSES:
            raise ValueError(f"unknown version status {status!r}")
        with self._connection() as conn, conn.transaction():
            applied = self._set_version_status(
                conn, name, version, status,
                reason=reason, expected_status=expected_status,
            )
        if not applied:
            if expected_status is not None:
                # CAS miss: the version wasn't in the expected status (a
                # concurrent writer moved it first). No-op, no event (TMP-23).
                return None
            raise KeyError(f"unknown agent version {name}@{version}")
        return self.get_agent_version(name, version)

    def _set_version_status(
        self,
        conn: Any,
        name: str,
        version: int,
        status: str,
        *,
        reason: str | None,
        expected_status: str | None = None,
    ) -> bool:
        """Transition a version on an already-open connection/transaction.

        Returns whether the row was updated. The ``update ... returning``
        detects a no-op by an empty result (TMP-14/TMP-23): an unknown version,
        or — when ``expected_status`` is given — a version no longer in the
        expected status (a lost compare-and-set race). The outbox event is
        written only when the update applied, so a no-op can never leave a
        phantom ``agent_version_status`` event. Shared by
        :meth:`set_version_status`, :meth:`resolve_promotion`, and canary
        graduation so the version transition is atomic with what drives it.
        """
        if expected_status is not None:
            updated = self._do_one(
                conn,
                "update agent_spec_versions set status = %s, status_reason = %s, "
                "decided_at = now() where name = %s and version = %s "
                "and status = %s returning version",
                (status, reason, name, version, expected_status),
            )
        else:
            updated = self._do_one(
                conn,
                "update agent_spec_versions set status = %s, status_reason = %s, "
                "decided_at = now() where name = %s and version = %s returning version",
                (status, reason, name, version),
            )
        if updated is None:
            return False
        self._do(
            conn,
            "insert into outbox (topic, payload) values (%s, %s)",
            (
                "agent_version_status",
                json.dumps(
                    {"name": name, "version": version,
                     "status": status, "reason": reason}
                ),
            ),
        )
        return True

    @staticmethod
    def _version_row(row: tuple | None) -> AgentVersionRecord | None:
        if row is None:
            return None
        return AgentVersionRecord(
            id=str(row[0]), name=row[1], version=row[2], spec_yaml=row[3],
            status=row[4], status_reason=row[5], decided_at=row[6],
            parent_version=row[7], created_by=row[8], created_at=row[9],
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
                   agent_ref, status, git_branch, started_at, completed_at, result
            from runs where id = %s
            """,
            (run_id,),
        )
        if row is None:
            return None
        result = row[9]
        if isinstance(result, str):
            result = json.loads(result)
        return RunRecord(
            id=row[0], temporal_workflow_id=row[1], abox_task_id=row[2],
            objective_id=row[3], agent_ref=row[4], phase=RunPhase(row[5]),
            git_branch=row[6], started_at=row[7], completed_at=row[8],
            result=result,
        )

    def completed_runs(
        self, agent_ref: str, limit: int | None = None
    ) -> list[RunRecord]:
        """Completed runs of one agent version, most recent first (design §3)."""
        sql = (
            "select id, temporal_workflow_id, abox_task_id, objective_id, "
            "agent_ref, status, git_branch, started_at, completed_at, result "
            "from runs where agent_ref = %s and status = 'completed' "
            "order by completed_at desc"
        )
        params: tuple = (agent_ref,)
        if limit is not None:
            sql += " limit %s"
            params = (agent_ref, limit)
        rows = self._all(sql, params)
        runs = []
        for row in rows:
            result = row[9]
            if isinstance(result, str):
                result = json.loads(result)
            runs.append(
                RunRecord(
                    id=row[0], temporal_workflow_id=row[1], abox_task_id=row[2],
                    objective_id=row[3], agent_ref=row[4], phase=RunPhase(row[5]),
                    git_branch=row[6], started_at=row[7], completed_at=row[8],
                    result=result,
                )
            )
        return runs

    def set_phase(self, run_id: str, phase: RunPhase) -> None:
        # The status update and its phase event are one write (TMP-16): a
        # crash between them must not leave the run advanced with no event
        # (or vice versa), matching create_run/set_version_status.
        with self._connection() as conn, conn.transaction():
            if phase == RunPhase.agent_running:
                # Parity with InMemoryLedger (TMP-9): the first agent_running
                # phase stamps started_at; coalesce keeps retries idempotent.
                self._do(
                    conn,
                    "update runs set status = %s, "
                    "started_at = coalesce(started_at, now()) where id = %s",
                    (phase.value, run_id),
                )
            else:
                self._do(
                    conn, "update runs set status = %s where id = %s", (phase.value, run_id)
                )
            self._append_event(
                conn,
                RunEvent(
                    run_id=run_id, event_type="phase",
                    payload={"phase": phase.value},
                    idem_key=f"phase:{phase.value}",
                ),
            )

    def finish_run(self, run_id: str, phase: RunPhase, result: dict | None) -> None:
        # The terminal update and its finished event are one write (TMP-16).
        with self._connection() as conn, conn.transaction():
            # Parity with InMemoryLedger (TMP-9): the terminal result lives on
            # the run row, not only inside the finished event payload.
            self._do(
                conn,
                "update runs set status = %s, completed_at = now(), result = %s "
                "where id = %s",
                (phase.value, json.dumps(result) if result is not None else None, run_id),
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
                (id, subject_type, subject_id, decision, rationale, scorecard,
                 status, approved_by, comment, resolved_at, gated_mutations,
                 requires_human, created_at)
            values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s, now())
            on conflict (id) do nothing
            """,
            (decision.id, card.subject_type, card.subject_id,
             decision.decision.value, decision.rationale,
             json.dumps(card.model_dump(mode="json")), decision.status,
             decision.approved_by, decision.comment, decision.resolved_at,
             json.dumps(decision.gated_mutations), decision.requires_human),
        )

    _PROMOTION_COLUMNS = (
        "id, decision, rationale, scorecard, status, approved_by, comment, "
        "resolved_at, gated_mutations, requires_human"
    )

    @classmethod
    def _promotion_row(cls, row: tuple) -> PromotionDecision:
        from ..evals.promotion import Decision
        from ..evals.scorecard import Scorecard

        scorecard = row[3] if isinstance(row[3], dict) else json.loads(row[3] or "{}")
        gated = row[8] if isinstance(row[8], list) else json.loads(row[8] or "[]")
        return PromotionDecision(
            decision=Decision(row[1]),
            rationale=row[2],
            scorecard=Scorecard.model_validate(scorecard),
            requires_human=bool(row[9]),
            gated_mutations=list(gated),
            id=row[0],
            status=row[4],
            approved_by=row[5],
            comment=row[6],
            resolved_at=row[7],
        )

    def promotions(self, status: str | None = None) -> list[PromotionDecision]:
        if status is None:
            rows = self._all(
                f"select {self._PROMOTION_COLUMNS} from promotion_decisions "
                "order by created_at",
            )
        else:
            rows = self._all(
                f"select {self._PROMOTION_COLUMNS} from promotion_decisions "
                "where status = %s order by created_at",
                (status,),
            )
        return [self._promotion_row(r) for r in rows]

    def resolve_promotion(
        self,
        promotion_id: str,
        *,
        approved: bool,
        approved_by: str,
        comment: str | None = None,
    ) -> PromotionDecision:
        """Resolve a PENDING human-gated decision (design §4, spec §25.3).

        The stored row is authoritative: scorecard and gated mutations come
        from the ledger, never the caller. Approve moves the candidate version
        ``pending_human -> canary``; reject moves it to ``rejected``.
        """
        from datetime import UTC, datetime

        from ..evals.promotion import parse_subject_version

        # One transaction on one connection (TMP-15): the read locks the row
        # with ``for update`` so a concurrent resolver blocks until this
        # commits and then sees a non-pending status; the decision update and
        # the cascading version transition are atomic, so a crash between them
        # can no longer leave the promotion resolved but the version un-moved.
        # (The previous code ran the read, the update, and the cascade on three
        # separate autocommit connections — a TOCTOU with no guard.)
        with self._connection() as conn, conn.transaction():
            row = self._do_one(
                conn,
                f"select {self._PROMOTION_COLUMNS} from promotion_decisions "
                "where id = %s for update",
                (promotion_id,),
            )
            if row is None:
                raise KeyError(f"Unknown promotion: {promotion_id}")
            decision = self._promotion_row(row)
            if decision.status != "pending":
                raise ValueError(
                    f"Promotion {promotion_id} already resolved "
                    f"(status={decision.status})"
                )

            decision.status = "approved" if approved else "rejected"
            decision.approved_by = approved_by
            decision.comment = comment
            decision.resolved_at = datetime.now(UTC)
            self._do(
                conn,
                "update promotion_decisions set status = %s, approved_by = %s, "
                "comment = %s, resolved_at = now() where id = %s",
                (decision.status, approved_by, comment, promotion_id),
            )

            card = decision.scorecard
            if card.subject_type == "agent_spec_version":
                subject = parse_subject_version(card.subject_id)
                if subject is not None:
                    verb = "approved" if approved else "rejected"
                    # A missing subject version (ad-hoc scorecards in dev
                    # tooling) is a no-op here — the resolution still stands,
                    # matching InMemoryLedger.
                    self._set_version_status(
                        conn, subject[0], subject[1],
                        "canary" if approved else "rejected",
                        reason=f"human {verb} by {approved_by}",
                    )
        return decision

    # --- trials ---
    _TRIAL_COLUMNS = (
        "id, experiment_id, run_id, objective_id, agent_ref, scenario_name, "
        "scenario_version, scenario_digest, seed, pins, metrics, evaluation, "
        "flags, status, started_at, completed_at"
    )

    def _ensure_trials_table(self, conn: Any) -> None:
        """Self-migrate the ``trials`` table (idempotent), mirroring
        :meth:`PgSemanticMemoryStore._ensure_outbox_table`. Applied lazily on
        the first trial write so an already-initialized database (whose
        ``init.sql`` predates this table) still works without a manual
        migration."""
        self._do(conn, _TRIALS_DDL, ())
        self._do(conn, _TRIALS_EXPERIMENT_INDEX_DDL, ())

    def record_trial(self, t: TrialRecord) -> None:
        """Insert-only (design section 6): a trial's outcome is immutable
        once recorded, so a duplicate id raises rather than overwrites."""
        with self._connection() as conn:
            self._ensure_trials_table(conn)
            with conn.cursor() as cur:
                cur.execute("select 1 from trials where id = %s", (t.id,))
                if cur.fetchone() is not None:
                    raise ValueError(f"trial {t.id} already recorded")
            self._do(
                conn,
                """
                insert into trials
                    (id, experiment_id, run_id, objective_id, agent_ref,
                     scenario_name, scenario_version, scenario_digest, seed,
                     pins, metrics, evaluation, flags, status, started_at,
                     completed_at)
                values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                """,
                (
                    t.id, t.experiment_id, t.run_id, t.objective_id, t.agent_ref,
                    t.scenario_name, t.scenario_version, t.scenario_digest, t.seed,
                    json.dumps(t.pins), json.dumps(t.metrics), json.dumps(t.evaluation),
                    json.dumps(t.flags.model_dump(mode="json")), t.status,
                    t.started_at, t.completed_at,
                ),
            )

    def get_trial(self, trial_id: str) -> TrialRecord | None:
        row = self._one(
            f"select {self._TRIAL_COLUMNS} from trials where id = %s",
            (trial_id,),
        )
        return self._trial_row(row)

    def list_trials(self, experiment_id: str | None = None) -> list[TrialRecord]:
        if experiment_id is None:
            rows = self._all(
                f"select {self._TRIAL_COLUMNS} from trials order by created_at"
            )
        else:
            rows = self._all(
                f"select {self._TRIAL_COLUMNS} from trials "
                "where experiment_id = %s order by created_at",
                (experiment_id,),
            )
        return [self._trial_row(r) for r in rows]

    @staticmethod
    def _trial_ts(value: Any) -> str | None:
        """Trial timestamps are plain ``str`` on the model (unlike
        ``RunRecord``'s ``datetime``); normalise the ``timestamptz`` value
        psycopg hands back into that shape."""
        if value is None or isinstance(value, str):
            return value
        return value.isoformat()

    @staticmethod
    def _trial_json(value: Any, default: str = "{}") -> Any:
        return value if isinstance(value, dict) else json.loads(value or default)

    @classmethod
    def _trial_row(cls, row: tuple | None) -> TrialRecord | None:
        if row is None:
            return None
        return TrialRecord(
            id=row[0], experiment_id=row[1], run_id=row[2], objective_id=row[3],
            agent_ref=row[4], scenario_name=row[5], scenario_version=row[6],
            scenario_digest=row[7], seed=row[8],
            pins=cls._trial_json(row[9]),
            metrics=cls._trial_json(row[10]),
            evaluation=cls._trial_json(row[11]),
            flags=HackFlags.model_validate(cls._trial_json(row[12])),
            status=row[13],
            started_at=cls._trial_ts(row[14]),
            completed_at=cls._trial_ts(row[15]),
        )

    # --- experiments ---
    _EXPERIMENT_COLUMNS = "id, name, spec, status, result, created_at, updated_at"

    def _ensure_experiments_table(self, conn: Any) -> None:
        """Self-migrate the ``experiments`` table (idempotent), mirroring
        :meth:`_ensure_trials_table`. Applied lazily on the first experiment
        write so an already-initialized database (whose ``init.sql``
        predates this table) still works without a manual migration."""
        self._do(conn, _EXPERIMENTS_DDL, ())

    def record_experiment(
        self, experiment_id: str, name: str, spec: dict, status: str
    ) -> None:
        """Insert the experiment row. Idempotent under retry (``on conflict
        do nothing``, matching :meth:`create_run`): a duplicate id is a
        retried write, not an error, and must not clobber an experiment that
        has already progressed past its initial status via
        :meth:`update_experiment_result`."""
        with self._connection() as conn:
            self._ensure_experiments_table(conn)
            self._do(
                conn,
                """
                insert into experiments (id, name, spec, status)
                values (%s,%s,%s,%s)
                on conflict (id) do nothing
                """,
                (experiment_id, name, json.dumps(spec), status),
            )

    def update_experiment_result(
        self, experiment_id: str, status: str, result: dict
    ) -> None:
        # No _ensure_experiments_table call here (see _EXPERIMENTS_DDL
        # comment): this is a read-before-first-write path on a legacy DB,
        # and it's supposed to raise UndefinedTable rather than silently
        # creating an empty table it then updates zero rows of.
        self._exec(
            "update experiments set status = %s, result = %s, updated_at = now() "
            "where id = %s",
            (status, json.dumps(result) if result is not None else None, experiment_id),
        )

    def get_experiment(self, experiment_id: str) -> dict[str, Any] | None:
        row = self._one(
            f"select {self._EXPERIMENT_COLUMNS} from experiments where id = %s",
            (experiment_id,),
        )
        if row is None:
            return None
        return {
            "id": row[0],
            "name": row[1],
            "spec": row[2] if isinstance(row[2], dict) else json.loads(row[2] or "{}"),
            "status": row[3],
            "result": row[4] if row[4] is None or isinstance(row[4], dict)
            else json.loads(row[4] or "{}"),
            "created_at": row[5],
            "updated_at": row[6],
        }
