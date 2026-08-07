"""The meta-agent's administrative tools (spec section 4.3).

These are the *only* capabilities the control-plane intelligence has. It has no
general shell, no unrestricted filesystem, and no arbitrary network tool — it
schedules and evaluates, but never executes repository code itself (section 19).

The class binds together the ledger, curriculum queues, agent-spec store, and
memory store, and delegates run execution to :func:`run_objective`.
"""

from __future__ import annotations

import concurrent.futures
from typing import Any

from .. import ids
from ..agent_spec import AgentSpec, parse_spec
from ..curriculum import Objective, ObjectiveQueues, QueueName
from ..evals import Scorecard, decide, evaluate_canary
from ..evals.promotion import PromotionPolicy
from ..memory import InMemoryStore, MemoryItem, MemoryRejected, MemoryStore
from ..registry import InMemoryLedger, RunPhase
from ..registry.ledger import Ledger
from ..registry.records import AgentVersionRecord
from .pipeline import PipelineResult, run_objective


class MetaAgentTools:
    def __init__(
        self,
        *,
        ledger: Ledger | None = None,
        memory: MemoryStore | None = None,
        weights=None,
    ) -> None:
        self.ledger = ledger or InMemoryLedger()
        self.memory = memory or InMemoryStore()
        self.queues = ObjectiveQueues() if weights is None else ObjectiveQueues(weights)
        # name -> {version: AgentSpec}
        self._specs: dict[str, dict[int, AgentSpec]] = {}
        self._objectives: dict[str, Objective] = {}
        self._runs: dict[str, PipelineResult] = {}
        # Background execution for the async API path (202 + poll).
        self._executor: concurrent.futures.ThreadPoolExecutor | None = None
        self._pending: dict[str, concurrent.futures.Future] = {}

    # --- objectives ---
    def create_objective(self, objective: dict[str, Any], queue: str = "ready") -> str:
        obj = Objective.model_validate(objective)
        obj.validate_against_schema()
        self._objectives[obj.id] = obj
        self.queues.add(obj, QueueName(queue))
        return obj.id

    def list_objectives(self, queue: str = "ready") -> list[dict[str, Any]]:
        return [o.to_dict() for o in self.queues.ranked(QueueName(queue))]

    # --- agent specs ---
    def register_agent_spec(self, spec: AgentSpec) -> AgentVersionRecord:
        from ..agent_spec import dump_yaml

        self._specs.setdefault(spec.metadata.name, {})[spec.metadata.version] = spec
        record = AgentVersionRecord(
            name=spec.metadata.name,
            version=spec.metadata.version,
            spec_yaml=dump_yaml(spec),
            status=spec.metadata.status.value,
            parent_version=spec.metadata.parent_version,
        )
        return self.ledger.upsert_agent_version(record)

    def create_candidate_agent_spec(self, spec_document: dict[str, Any]) -> str:
        spec = parse_spec(spec_document)
        if spec.metadata.status.value != "candidate":
            raise ValueError("New agent specs must be created with status=candidate.")
        self.register_agent_spec(spec)
        return spec.ref

    def _resolve_spec(self, agent: str) -> AgentSpec:
        """Resolve ``name`` (active) or ``name@version`` to an AgentSpec."""
        if "@" in agent:
            name, version_s = agent.split("@", 1)
            spec = self._specs.get(name, {}).get(int(version_s))
            if spec is None:
                raise KeyError(f"Unknown agent spec: {agent}")
            return spec
        versions = self._specs.get(agent)
        if not versions:
            raise KeyError(f"Unknown agent: {agent}")
        return versions[max(versions)]

    # --- runs ---
    def spawn_agent_run(self, objective_id: str, agent: str) -> str:
        objective = self._objectives[objective_id]
        spec = self._resolve_spec(agent)
        pipeline = run_objective(objective, spec, ledger=self.ledger, memory=self.memory)
        self._runs[pipeline.run_id] = pipeline
        return pipeline.run_id

    def _jobs(self) -> concurrent.futures.ThreadPoolExecutor:
        if self._executor is None:
            self._executor = concurrent.futures.ThreadPoolExecutor(
                max_workers=4, thread_name_prefix="bakudo-api-run"
            )
        return self._executor

    def spawn_agent_run_async(self, objective_id: str, agent: str) -> str:
        """Start a run in the background and return its pre-allocated run id.

        The async half of the API's 202-Accepted pattern: the run id is handed
        out immediately, execution happens on the tools executor, and
        :meth:`query_agent_run` reports live phase throughout.
        """
        objective = self._objectives[objective_id]  # KeyError -> 404 upstream
        spec = self._resolve_spec(agent)
        run_id = ids.run_id()

        def execute() -> PipelineResult:
            pipeline = run_objective(
                objective, spec, ledger=self.ledger, memory=self.memory, run_id=run_id
            )
            self._runs[run_id] = pipeline
            return pipeline

        self._pending[run_id] = self._jobs().submit(execute)
        return run_id

    def query_agent_run(self, run_id: str) -> dict[str, Any]:
        record = self.ledger.get_run(run_id)
        if record is None:
            # A just-accepted async run may not have reached the ledger yet.
            pending = self._pending.get(run_id)
            if pending is not None and not pending.done():
                return {"id": run_id, "phase": "created", "scorecard": None}
            raise KeyError(f"Unknown run: {run_id}")
        pipeline = self._runs.get(run_id)
        return {
            "id": record.id,
            "agent": record.agent_ref,
            "objective_id": record.objective_id,
            "phase": record.phase.value,
            "git_branch": record.git_branch,
            "scorecard": pipeline.scorecard.model_dump(mode="json")
            if pipeline and pipeline.scorecard
            else None,
        }

    def cancel_agent_run(self, run_id: str) -> None:
        self.ledger.finish_run(run_id, RunPhase.cancelled, None)

    def compare_runs(self, run_ids: list[str]) -> list[dict[str, Any]]:
        """Compare candidates on diff size, tests, eval score (section 9.1)."""
        rows = []
        for rid in run_ids:
            p = self._runs.get(rid)
            if not p or not p.result:
                continue
            rows.append(
                {
                    "run_id": rid,
                    "agent": p.result.agent,
                    "status": p.result.status.value,
                    "changed_files": len(p.result.changed_files),
                    "tests_passed": sum(1 for t in p.result.tests_run if t.status == "passed"),
                    "overall_score": p.scorecard.overall_score if p.scorecard else 0.0,
                }
            )
        return sorted(rows, key=lambda r: r["overall_score"], reverse=True)

    # --- evals & promotion ---
    # (Per-run evaluation happens inside run_objective via the shared
    # pipeline core — there is deliberately no second eval entry point here.)

    def promote_candidate(
        self,
        candidate_scorecard: dict[str, Any],
        baseline_scorecard: dict[str, Any] | None = None,
        mutation_kinds: list[str] | None = None,
    ) -> dict[str, Any]:
        candidate = Scorecard.model_validate(candidate_scorecard)
        baseline = Scorecard.model_validate(baseline_scorecard) if baseline_scorecard else None
        decision = decide(
            candidate, baseline, policy=PromotionPolicy(), mutation_kinds=mutation_kinds or []
        )
        self.ledger.record_promotion(decision)
        return decision.to_dict()

    def advance_canary(
        self,
        candidate_scorecard: dict[str, Any],
        canary_run_scorecards: list[dict[str, Any]],
    ) -> dict[str, Any]:
        """Advance (or fail) a canaried candidate from its observed runs.

        The terminal half of the promotion flow: :meth:`promote_candidate`
        routes eligible candidates to canary, and this decides promote /
        keep-observing / reject from the canary runs' scorecards.
        """
        candidate = Scorecard.model_validate(candidate_scorecard)
        runs = [Scorecard.model_validate(s) for s in canary_run_scorecards]
        decision = evaluate_canary(candidate, runs, policy=PromotionPolicy())
        self.ledger.record_promotion(decision)
        return decision.to_dict()

    def archive_candidate(self, agent: str, reason: str) -> dict[str, str]:
        spec = self._resolve_spec(agent)
        self.register_agent_spec(
            spec.model_copy(
                update={"metadata": spec.metadata.model_copy(update={"status": "archived"})}
            )
        )
        return {"agent": spec.ref, "status": "archived", "reason": reason}

    # --- memory ---
    def query_memory(self, scope: dict[str, Any] | None = None, limit: int = 10) -> list[dict]:
        return [m.to_dict() for m in self.memory.query(scope=scope, limit=limit)]

    def write_memory_candidate(self, item: dict[str, Any]) -> dict[str, Any]:
        candidate = MemoryItem.model_validate(item)
        try:
            stored = self.memory.write_candidate(candidate)
        except MemoryRejected as exc:
            return {"accepted": False, "reasons": str(exc).split("; ")}
        return {"accepted": True, "id": stored.id}

    # --- inspection ---
    def query_logs(self, run_id: str) -> list[dict[str, Any]]:
        return [
            {"ts": e.ts.isoformat(), "event_type": e.event_type, "payload": e.payload}
            for e in self.ledger.events(run_id)
        ]
