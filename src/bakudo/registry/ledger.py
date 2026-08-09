"""The :class:`Ledger` interface and an in-memory reference implementation.

The ledger is the authoritative record of agent versions, runs, the run event
log, eval results, and promotion decisions. The control plane reads and writes
it exclusively through activities (Temporal rule, spec section 11.2).
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any, Protocol

from ..evals.promotion import PromotionDecision
from ..evals.result import EvalResult
from .records import VERSION_STATUSES, AgentVersionRecord, RunEvent, RunPhase, RunRecord


class Ledger(Protocol):
    # Agent versions. The first version registered for a name becomes
    # ``active``; later versions keep their submitted status and move through
    # the design §1 state machine via :meth:`set_version_status`, each
    # transition producing an event.
    def upsert_agent_version(self, record: AgentVersionRecord) -> AgentVersionRecord: ...
    def active_version(self, name: str) -> AgentVersionRecord | None: ...
    def canary_version(self, name: str) -> AgentVersionRecord | None: ...
    def get_agent_version(self, name: str, version: int) -> AgentVersionRecord | None: ...
    def set_version_status(
        self, name: str, version: int, status: str, *, reason: str | None = None
    ) -> AgentVersionRecord | None: ...

    # Runs. ``objective`` is the objective document backing the run: durable
    # backends upsert it first so the runs FK holds (TMP-2).
    def create_run(
        self, record: RunRecord, objective: dict[str, Any] | None = None
    ) -> RunRecord: ...
    def get_run(self, run_id: str) -> RunRecord | None: ...
    def set_phase(self, run_id: str, phase: RunPhase) -> None: ...
    def finish_run(self, run_id: str, phase: RunPhase, result: dict | None) -> None: ...
    def append_event(self, event: RunEvent) -> None: ...
    def events(self, run_id: str) -> list[RunEvent]: ...
    def completed_runs(
        self, agent_ref: str, limit: int | None = None
    ) -> list[RunRecord]: ...

    # Evals & promotions
    def record_eval(self, result: EvalResult) -> None: ...
    def eval_results(self, subject_id: str) -> list[EvalResult]: ...
    def record_promotion(self, decision: PromotionDecision) -> None: ...
    def promotions(self, status: str | None = None) -> list[PromotionDecision]: ...
    def resolve_promotion(
        self,
        promotion_id: str,
        *,
        approved: bool,
        approved_by: str,
        comment: str | None = None,
    ) -> PromotionDecision: ...


class InMemoryLedger:
    """A dependency-free ledger for tests and single-process dev."""

    def __init__(self) -> None:
        self._versions: dict[str, AgentVersionRecord] = {}  # key: name@version
        self._objectives: dict[str, dict[str, Any]] = {}
        self._runs: dict[str, RunRecord] = {}
        self._events: dict[str, list[RunEvent]] = {}
        self._evals: dict[str, list[EvalResult]] = {}
        self._promotions: list[PromotionDecision] = []

    @staticmethod
    def _vkey(name: str, version: int) -> str:
        return f"{name}@{version}"

    # --- agent versions ---
    def upsert_agent_version(self, record: AgentVersionRecord) -> AgentVersionRecord:
        key = self._vkey(record.name, record.version)
        first_of_name = key not in self._versions and not any(
            v.name == record.name for v in self._versions.values()
        )
        if first_of_name and record.status != "active":
            # Design §1: the first version registered for a name is the one
            # runs resolve, so it activates immediately.
            record = record.model_copy(
                update={
                    "status": "active",
                    "status_reason": "first version registered for name",
                }
            )
        self._versions[key] = record
        return record

    def _latest_with_status(self, name: str, status: str) -> AgentVersionRecord | None:
        matches = [
            v for v in self._versions.values()
            if v.name == name and v.status == status
        ]
        return max(matches, key=lambda v: v.version, default=None)

    def active_version(self, name: str) -> AgentVersionRecord | None:
        return self._latest_with_status(name, "active")

    def canary_version(self, name: str) -> AgentVersionRecord | None:
        return self._latest_with_status(name, "canary")

    def get_agent_version(self, name: str, version: int) -> AgentVersionRecord | None:
        return self._versions.get(self._vkey(name, version))

    def set_version_status(
        self, name: str, version: int, status: str, *, reason: str | None = None
    ) -> AgentVersionRecord:
        """Transition a version through the §1 state machine, with an event."""
        if status not in VERSION_STATUSES:
            raise ValueError(f"unknown version status {status!r}")
        key = self._vkey(name, version)
        record = self._versions[key]  # KeyError on unknown version
        updated = record.model_copy(
            update={
                "status": status,
                "status_reason": reason,
                "decided_at": datetime.now(UTC),
            }
        )
        self._versions[key] = updated
        self.append_event(
            RunEvent(
                run_id=f"agent:{key}",
                event_type="version_status",
                payload={
                    "name": name, "version": version,
                    "status": status, "reason": reason,
                },
            )
        )
        return updated

    # --- runs ---
    def create_run(
        self, record: RunRecord, objective: dict[str, Any] | None = None
    ) -> RunRecord:
        if objective is not None:
            self._objectives.setdefault(record.objective_id, objective)
        self._runs[record.id] = record
        self._events.setdefault(record.id, [])
        self.append_event(
            RunEvent(run_id=record.id, event_type="created", idem_key="created")
        )
        return record

    def objectives(self) -> dict[str, dict[str, Any]]:
        return dict(self._objectives)

    def get_run(self, run_id: str) -> RunRecord | None:
        return self._runs.get(run_id)

    def set_phase(self, run_id: str, phase: RunPhase) -> None:
        run = self._runs[run_id]
        run.phase = phase
        if phase == RunPhase.agent_running and run.started_at is None:
            run.started_at = datetime.now(UTC)
        self.append_event(
            RunEvent(
                run_id=run_id, event_type="phase",
                payload={"phase": phase.value}, idem_key=f"phase:{phase.value}",
            )
        )

    def finish_run(self, run_id: str, phase: RunPhase, result: dict | None) -> None:
        run = self._runs[run_id]
        run.phase = phase
        run.result = result
        run.completed_at = datetime.now(UTC)
        self.append_event(
            RunEvent(
                run_id=run_id, event_type="finished",
                payload={"phase": phase.value}, idem_key="finished",
            )
        )

    def append_event(self, event: RunEvent) -> None:
        events = self._events.setdefault(event.run_id, [])
        # Idempotent under retry, matching the durable backend (TMP-8).
        if event.idem_key is not None and any(
            e.idem_key == event.idem_key for e in events
        ):
            return
        events.append(event)

    def events(self, run_id: str) -> list[RunEvent]:
        return list(self._events.get(run_id, []))

    def completed_runs(
        self, agent_ref: str, limit: int | None = None
    ) -> list[RunRecord]:
        """Completed runs of one agent version, most recent first (design §3)."""
        runs = sorted(
            (
                r for r in self._runs.values()
                if r.agent_ref == agent_ref
                and r.phase == RunPhase.completed
                and r.completed_at is not None
            ),
            key=lambda r: r.completed_at,  # type: ignore[arg-type, return-value]
            reverse=True,
        )
        return runs[:limit] if limit is not None else runs

    # --- evals & promotions ---
    def record_eval(self, result: EvalResult) -> None:
        self._evals.setdefault(result.subject_id, []).append(result)

    def eval_results(self, subject_id: str) -> list[EvalResult]:
        return list(self._evals.get(subject_id, []))

    def record_promotion(self, decision: PromotionDecision) -> None:
        self._promotions.append(decision)

    def promotions(self, status: str | None = None) -> list[PromotionDecision]:
        return [p for p in self._promotions if status is None or p.status == status]

    def resolve_promotion(
        self,
        promotion_id: str,
        *,
        approved: bool,
        approved_by: str,
        comment: str | None = None,
    ) -> PromotionDecision:
        """Resolve a PENDING human-gated decision (design §4, spec §25.3).

        Approve moves the candidate version ``pending_human -> canary``;
        reject moves it to ``rejected``. The scorecard and gated mutations are
        the STORED ones — nothing from the caller is trusted beyond identity
        and commentary.
        """
        decision = next(
            (p for p in self._promotions if p.id == promotion_id), None
        )
        if decision is None:
            raise KeyError(f"Unknown promotion: {promotion_id}")
        if decision.status != "pending":
            raise ValueError(
                f"Promotion {promotion_id} already resolved (status={decision.status})"
            )
        decision.status = "approved" if approved else "rejected"
        decision.approved_by = approved_by
        decision.comment = comment
        decision.resolved_at = datetime.now(UTC)

        self._transition_decision_subject(decision, approved)
        return decision

    def _transition_decision_subject(
        self, decision: PromotionDecision, approved: bool
    ) -> None:
        from ..evals.promotion import parse_subject_version

        card = decision.scorecard
        if card.subject_type != "agent_spec_version":
            return
        subject = parse_subject_version(card.subject_id)
        if subject is None:
            return
        verb = "approved" if approved else "rejected"
        try:
            self.set_version_status(
                subject[0], subject[1],
                "canary" if approved else "rejected",
                reason=f"human {verb} by {decision.approved_by}",
            )
        except KeyError:
            pass
