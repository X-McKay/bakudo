"""The meta-agent's administrative tools (spec section 4.3).

These are the *only* capabilities the control-plane intelligence has. It has no
general shell, no unrestricted filesystem, and no arbitrary network tool — it
schedules and evaluates, but never executes repository code itself (section 19).

The class binds together the ledger, curriculum queues, agent-spec store, and
memory store, and delegates run execution to :func:`run_objective`.
"""

from __future__ import annotations

from typing import Any

from .. import ids
from ..agent_spec import AgentSpec, parse_spec
from ..curriculum import Objective, ObjectiveQueues, QueueName
from ..evals import EvalContext, Scorecard, assemble_suite, decide
from ..evals.promotion import PromotionPolicy, apply_decision, routes_to_canary
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

    def _spec_for(self, record) -> AgentSpec:
        """The AgentSpec object behind a ledger version record."""
        spec = self._specs.get(record.name, {}).get(record.version)
        if spec is None:
            # Registered directly against the ledger; the YAML is authoritative.
            import yaml

            spec = parse_spec(yaml.safe_load(record.spec_yaml))
            self._specs.setdefault(record.name, {})[record.version] = spec
        return spec

    def _resolve_spec(self, agent: str, run_id: str | None = None) -> AgentSpec:
        """Resolve an agent ref to a *spawnable* spec (design §2, fixes OPT-5).

        ``name`` resolves to the ACTIVE version only — candidates, rejected,
        and archived versions never shadow it. When a canary version exists
        and a ``run_id`` is given, ``hash(run_id) % 100 < canary_percent``
        deterministically routes that run to the canary. A pinned
        ``name@version`` resolves only while that version is active or canary.
        """
        if "@" in agent:
            name, version_s = agent.split("@", 1)
            record = self.ledger.get_agent_version(name, int(version_s))
            if record is None:
                raise KeyError(f"Unknown agent spec: {agent}")
            if record.status not in ("active", "canary"):
                raise KeyError(
                    f"Agent spec {agent} is not spawnable (status={record.status})"
                )
            return self._spec_for(record)

        if agent not in self._specs and self.ledger.active_version(agent) is None:
            raise KeyError(f"Unknown agent: {agent}")
        if run_id is not None:
            canary = self.ledger.canary_version(agent)
            if canary is not None and routes_to_canary(
                run_id, PromotionPolicy().canary_percent
            ):
                return self._spec_for(canary)
        active = self.ledger.active_version(agent)
        if active is None:
            raise KeyError(f"No active version for agent: {agent}")
        return self._spec_for(active)

    # --- runs ---
    def spawn_agent_run(self, objective_id: str, agent: str, *, sandbox=None) -> str:
        objective = self._objectives[objective_id]
        # The run id is minted before spec resolution so canary routing is
        # deterministic per run (design §2).
        run_id = ids.run_id()
        spec = self._resolve_spec(agent, run_id=run_id)
        pipeline = run_objective(
            objective, spec, ledger=self.ledger, sandbox=sandbox, run_id=run_id
        )
        self._runs[pipeline.run_id] = pipeline
        return pipeline.run_id

    def query_agent_run(self, run_id: str) -> dict[str, Any]:
        record = self.ledger.get_run(run_id)
        if record is None:
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
    def run_eval_suite(self, run_id: str) -> dict[str, Any]:
        pipeline = self._runs[run_id]
        if pipeline.result is None:
            raise ValueError("Run produced no result to evaluate.")
        ctx = EvalContext(
            result=pipeline.result, objective=self._objectives[pipeline.result.objective_id]
        )
        # Same assembler as the run paths (TMP-22): objective-type-aware, so an
        # optimize run gets its simplicity check here too. Performance remains
        # independently measured evidence. No critic: this surface has no sandbox.
        results = assemble_suite(ctx, with_critic=False)
        scorecard = Scorecard.from_results(results)
        return {
            "eval_results": [r.to_dict() for r in results],
            "scorecard": scorecard.model_dump(mode="json"),
        }

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
        # Record the decision AND move the candidate version through the §1
        # state machine (reject -> rejected, human gate -> pending_human,
        # auto-pass -> canary), fixing OPT-7's dead-end decisions.
        apply_decision(self.ledger, decision)
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

    def query_temporal_workflow(self, run_id: str) -> dict[str, Any]:
        record = self.ledger.get_run(run_id)
        if record is None:
            raise KeyError(f"Unknown run: {run_id}")
        return {
            "workflow_id": record.temporal_workflow_id,
            "phase": record.phase.value,
            "events": len(self.ledger.events(run_id)),
        }
