"""The :class:`Ledger` interface and an in-memory reference implementation.

The ledger is the authoritative record of agent versions, runs, the run event
log, eval results, and promotion decisions. The control plane reads and writes
it exclusively through activities (Temporal rule, spec section 11.2).
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Protocol

from ..evals.promotion import PromotionDecision
from ..evals.result import EvalResult
from .records import AgentVersionRecord, RunEvent, RunPhase, RunRecord


class Ledger(Protocol):
    # Agent versions
    def upsert_agent_version(self, record: AgentVersionRecord) -> AgentVersionRecord: ...
    def active_version(self, name: str) -> AgentVersionRecord | None: ...
    def get_agent_version(self, name: str, version: int) -> AgentVersionRecord | None: ...

    # Runs
    def create_run(self, record: RunRecord) -> RunRecord: ...
    def get_run(self, run_id: str) -> RunRecord | None: ...
    def set_phase(self, run_id: str, phase: RunPhase) -> None: ...
    def finish_run(self, run_id: str, phase: RunPhase, result: dict | None) -> None: ...
    def append_event(self, event: RunEvent) -> None: ...
    def events(self, run_id: str) -> list[RunEvent]: ...

    # Evals & promotions
    def record_eval(self, result: EvalResult) -> None: ...
    def eval_results(self, subject_id: str) -> list[EvalResult]: ...
    def record_promotion(self, decision: PromotionDecision) -> None: ...


class InMemoryLedger:
    """A dependency-free ledger for tests and single-process dev."""

    def __init__(self) -> None:
        self._versions: dict[str, AgentVersionRecord] = {}  # key: name@version
        self._runs: dict[str, RunRecord] = {}
        self._events: dict[str, list[RunEvent]] = {}
        self._evals: dict[str, list[EvalResult]] = {}
        self._promotions: list[PromotionDecision] = []

    @staticmethod
    def _vkey(name: str, version: int) -> str:
        return f"{name}@{version}"

    # --- agent versions ---
    def upsert_agent_version(self, record: AgentVersionRecord) -> AgentVersionRecord:
        self._versions[self._vkey(record.name, record.version)] = record
        return record

    def active_version(self, name: str) -> AgentVersionRecord | None:
        actives = [
            v for v in self._versions.values()
            if v.name == name and v.status == "active"
        ]
        return max(actives, key=lambda v: v.version, default=None)

    def get_agent_version(self, name: str, version: int) -> AgentVersionRecord | None:
        return self._versions.get(self._vkey(name, version))

    # --- runs ---
    def create_run(self, record: RunRecord) -> RunRecord:
        self._runs[record.id] = record
        self._events.setdefault(record.id, [])
        self.append_event(RunEvent(run_id=record.id, event_type="created"))
        return record

    def get_run(self, run_id: str) -> RunRecord | None:
        return self._runs.get(run_id)

    def set_phase(self, run_id: str, phase: RunPhase) -> None:
        run = self._runs[run_id]
        run.phase = phase
        if phase == RunPhase.agent_running and run.started_at is None:
            run.started_at = datetime.now(UTC)
        self.append_event(
            RunEvent(run_id=run_id, event_type="phase", payload={"phase": phase.value})
        )

    def finish_run(self, run_id: str, phase: RunPhase, result: dict | None) -> None:
        run = self._runs[run_id]
        run.phase = phase
        run.result = result
        run.completed_at = datetime.now(UTC)
        self.append_event(
            RunEvent(run_id=run_id, event_type="finished", payload={"phase": phase.value})
        )

    def append_event(self, event: RunEvent) -> None:
        self._events.setdefault(event.run_id, []).append(event)

    def events(self, run_id: str) -> list[RunEvent]:
        return list(self._events.get(run_id, []))

    # --- evals & promotions ---
    def record_eval(self, result: EvalResult) -> None:
        self._evals.setdefault(result.subject_id, []).append(result)

    def eval_results(self, subject_id: str) -> list[EvalResult]:
        return list(self._evals.get(subject_id, []))

    def record_promotion(self, decision: PromotionDecision) -> None:
        self._promotions.append(decision)

    def promotions(self) -> list[PromotionDecision]:
        return list(self._promotions)
