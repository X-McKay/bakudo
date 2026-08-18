"""Workflow tests against the Temporal time-skipping test environment.

These are the first real workflow tests in the codebase (the TMP-* findings
shipped precisely because none existed). They run workflows on an in-process
Worker wired to the same thread-pool activity executor production uses, with
the sandbox stubbed and the InMemoryLedger injected — no live services.
"""

from __future__ import annotations

import asyncio
import time
from concurrent.futures import ThreadPoolExecutor

import pytest
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import Worker

from bakudo.abox.runner import AboxOutcome
from bakudo.registry import InMemoryLedger
from bakudo.temporal import _impl
from bakudo.temporal.activities import ALL_ACTIVITIES
from bakudo.temporal.client import META_WORKFLOW_ID
from bakudo.temporal.shared import TASK_QUEUE_CONTROL, resolve_agent_name
from bakudo.temporal.workflows import (
    AgentRunWorkflow,
    EvalWorkflow,
    MetaAgentWorkflow,
    MetaState,
    OptimizationWorkflow,
    PerformanceComparisonWorkflow,
)

_PERFORMANCE_DIGEST = "sha256:" + "0" * 64


def _performance_contract():
    return {
        "workloadRef": {
            "name": "smoke-python-loop",
            "version": "1.0.0",
            "source": "repository",
        },
        "primaryMetric": "latency_seconds",
        "decisionPolicy": {
            "confidence": 0.95,
            "minimumRelativeImprovement": 0.05,
            "protectedMetrics": [],
            "bootstrapResamples": 10_000,
        },
    }


def _prepared_performance():
    environment = {
        "bakudoVersion": "3.0.0",
        "aboxVersion": "1.0.0",
        "imageDigest": _PERFORMANCE_DIGEST,
        "profile": "python-small",
        "hardwareClass": "test",
        "architecture": "arm64",
        "cpuCount": 2,
        "memoryMb": 512,
        "os": "linux",
        "kernel": "test",
        "dependencyLockDigest": _PERFORMANCE_DIGEST,
        "environmentDigest": _PERFORMANCE_DIGEST,
    }
    return {
        "status": "completed",
        "workload": "smoke-python-loop@1.0.1",
        "workloadSource": "package://bakudo/smoke-workloads",
        "workloadPin": {
            "sourceURI": "file:///trusted/workloads",
            "sourceKind": "repository",
            "collectionRevision": "base",
            "name": "smoke-python-loop",
            "version": "1.0.0",
            "manifestDigest": _PERFORMANCE_DIGEST,
            "bundleDigest": _PERFORMANCE_DIGEST,
        },
        "baselineRevision": {
            "repository": "bakudo",
            "sourceURI": "file:///repo",
            "commitSHA": "a" * 40,
            "treeDigest": _PERFORMANCE_DIGEST,
        },
        "environment": environment,
    }


def _trusted_performance_comparison(inp, cancel_event=None, *, effect=0.2):
    from bakudo.temporal.shared import PerformanceWorkflowResult

    del cancel_event
    prepared = _prepared_performance()
    verdict = "improved" if effect > 0.05 else "equivalent"
    record = {
        "id": inp.comparison_id,
        "workload": prepared["workloadPin"],
        "baselineRevision": inp.baseline_revision,
        "candidateRevision": inp.candidate_revision,
        "baselineEnvironment": inp.baseline_environment,
        "candidateEnvironment": inp.candidate_environment,
        "baselineMeasurementId": inp.baseline_measurement_id,
        "candidateMeasurementId": inp.candidate_measurement_id,
        "primaryMetric": "latency_seconds",
        "metrics": [
            {
                "metricName": "latency_seconds",
                "unit": "seconds",
                "direction": "lower",
                "estimator": "median",
                "baselineSummary": 10.0,
                "candidateSummary": 10.0 * (1 - effect),
                "absoluteEffect": 10.0 * effect,
                "relativeEffect": effect,
                "ciLower": max(0.0, effect - 0.02),
                "ciUpper": effect + 0.02,
                "practicalThreshold": 0.05,
                "sampleCount": 10,
                "verdict": verdict,
                "valid": True,
            }
        ],
        "status": "completed",
        "verdict": verdict,
        "integrity": {"valid": True},
        "eligible": verdict == "improved",
        "analysisSeed": inp.seed,
        "confidence": inp.confidence,
        "bootstrapResamples": inp.bootstrap_resamples,
    }
    return PerformanceWorkflowResult(
        operation_id=inp.operation_id,
        kind="comparison",
        status="completed",
        record_id=inp.comparison_id,
        record=record,
    )

# --- deterministic agent-name resolution (TMP-3) ---


def test_resolve_agent_name_prefers_suggested_agents():
    objective = {"id": "o", "type": "explore", "suggestedAgents": ["qa", "explore"]}
    assert resolve_agent_name(objective) == "qa"


def test_resolve_agent_name_falls_back_to_type_default():
    assert resolve_agent_name({"id": "o", "type": "explore"}) == "explore"
    assert resolve_agent_name({"id": "o", "type": "optimize"}) == "optimize-scout"


def test_resolve_agent_name_unresolvable_returns_none():
    assert resolve_agent_name({"id": "o", "type": "skill-gen"}) is None
    assert resolve_agent_name({"id": "o"}) is None


# --- WorkflowEnvironment scaffolding ---


def stub_sandbox(bundle):
    """A successful sandbox outcome with a schema-valid result."""
    return AboxOutcome(
        run_id=bundle.run_id,
        abox_task_id=bundle.run_id,
        exit_code=0,
        git_branch=f"agent/{bundle.run_id}",
        result={
            "run_id": bundle.run_id,
            "agent": "explore@1",
            "objective_id": bundle.objective_id,
            "status": "success",
            "summary": "stubbed sandbox run",
        },
    )


@pytest.fixture
def deps(monkeypatch):
    ledger = InMemoryLedger()
    monkeypatch.setattr(_impl.DEPS, "ledger", ledger)
    monkeypatch.setattr(_impl.DEPS, "sandbox", stub_sandbox)
    monkeypatch.setattr(
        _impl,
        "prepare_performance_optimization",
        lambda _objective: _prepared_performance(),
    )
    monkeypatch.setattr(
        _impl,
        "run_performance_comparison",
        _trusted_performance_comparison,
    )
    return ledger


@pytest.fixture
async def env():
    environment = await WorkflowEnvironment.start_time_skipping()
    yield environment
    await environment.shutdown()


def make_worker(env, workflows):
    return Worker(
        env.client,
        task_queue=TASK_QUEUE_CONTROL,
        workflows=workflows,
        activities=ALL_ACTIVITIES,
        activity_executor=ThreadPoolExecutor(max_workers=8, thread_name_prefix="test-act"),
    )


async def _poll(predicate, timeout=15.0, interval=0.1):
    """Await a condition fed by real-time activity completions."""
    deadline = asyncio.get_event_loop().time() + timeout
    while asyncio.get_event_loop().time() < deadline:
        if await predicate():
            return True
        await asyncio.sleep(interval)
    return False


# --- flagship happy path: full AgentRunWorkflow lifecycle ---


async def test_agent_run_workflow_happy_path_writes_full_event_log(env, deps):
    from bakudo.temporal.shared import AgentRunInput

    spec = _impl.load_agent_spec("explore")
    async with make_worker(env, [AgentRunWorkflow, EvalWorkflow]):
        out = await env.client.execute_workflow(
            AgentRunWorkflow.run,
            AgentRunInput(
                run_id="run_HAPPY1",
                objective={"id": "obj_HAPPY1", "type": "explore", "repo": "bakudo",
                           "title": "happy path"},
                agent_spec=spec,
            ),
            id="run-run_HAPPY1",
            task_queue=TASK_QUEUE_CONTROL,
        )

    assert out.phase == "completed"
    assert out.result["status"] == "success"
    assert out.scorecard is not None
    assert out.eval_results, "eval results must flow back through the child workflow"

    run = deps.get_run("run_HAPPY1")
    assert run.phase.value == "completed"
    assert run.started_at is not None and run.completed_at is not None
    assert run.result == out.result

    events = deps.events("run_HAPPY1")
    kinds = [e.event_type for e in events]
    assert kinds[0] == "created" and kinds.count("created") == 1
    assert kinds.count("finished") == 1
    phases = [e.payload.get("phase") for e in events if e.event_type == "phase"]
    # No `sandbox_starting`: it and `agent_running` were persisted back-to-back
    # before the sandbox even booted, so the distinction was illusory. This now
    # matches the synchronous pipeline mirror, which records the same sequence.
    assert phases == [
        "bundle_rendered", "agent_running",
        "collecting_artifacts", "evaluating",
    ]
    # Evals were recorded against the run.
    assert deps.eval_results("run_HAPPY1")


# --- canary graduation is wired into the completion path (design §3) ---


async def test_completed_canary_run_triggers_graduation(env, deps, monkeypatch):
    """AgentRunWorkflow's completion path invokes check_canary_graduation:
    once the canary has enough completed runs it graduates to active and the
    old active is archived — all as ledger writes with events."""
    from bakudo.evals.promotion import PromotionPolicy
    from bakudo.registry.records import AgentVersionRecord
    from bakudo.temporal.shared import AgentRunInput

    spec = _impl.load_agent_spec("explore")
    canary_spec = {**spec, "metadata": {**spec["metadata"], "version": 2}}

    import yaml

    for version, status, doc in ((1, "active", spec), (2, "candidate", canary_spec)):
        deps.upsert_agent_version(
            AgentVersionRecord(
                name="explore", version=version, status=status,
                spec_yaml=yaml.safe_dump(doc),
            )
        )
    deps.set_version_status("explore", 2, "canary", reason="auto-pass")
    monkeypatch.setattr(
        _impl, "PROMOTION_POLICY", PromotionPolicy(canary_min_runs=1)
    )

    async with make_worker(env, [AgentRunWorkflow, EvalWorkflow]):
        out = await env.client.execute_workflow(
            AgentRunWorkflow.run,
            AgentRunInput(
                run_id="run_GRAD1",
                objective={"id": "obj_GRAD1", "type": "explore", "repo": "bakudo",
                           "title": "canary run"},
                agent_spec=canary_spec,
            ),
            id="run-run_GRAD1",
            task_queue=TASK_QUEUE_CONTROL,
        )

    assert out.phase == "completed"
    assert deps.get_agent_version("explore", 2).status == "active"
    assert deps.get_agent_version("explore", 1).status == "archived"
    assert any(d.decision.value == "promote" for d in deps.promotions())


# --- singleton startup (TMP-7) ---


async def test_ensure_meta_agent_double_call_is_a_noop(env):
    """The second ensure must attach to the running singleton, not raise
    WorkflowAlreadyStartedError."""
    from temporalio.client import WorkflowExecutionStatus

    from bakudo.temporal.client import ensure_meta_agent

    first = await ensure_meta_agent(env.client)
    second = await ensure_meta_agent(env.client)
    assert first.id == second.id == META_WORKFLOW_ID

    desc = await env.client.get_workflow_handle(META_WORKFLOW_ID).describe()
    assert desc.status == WorkflowExecutionStatus.RUNNING


# --- meta-agent dispatch (TMP-3) ---


async def test_meta_dispatches_observer_objective_without_agent_spec(env, deps):
    """Observer objectives carry suggestedAgents, never agent_spec — dispatch
    must resolve the spec instead of KeyError-wedging the singleton."""
    async with make_worker(env, [MetaAgentWorkflow, AgentRunWorkflow, EvalWorkflow]):
        handle = await env.client.start_workflow(
            MetaAgentWorkflow.run, id=META_WORKFLOW_ID, task_queue=TASK_QUEUE_CONTROL
        )
        await handle.signal(
            MetaAgentWorkflow.new_objective,
            {
                "id": "obj_OBS1",
                "type": "explore",
                "repo": "bakudo",
                "title": "observer objective",
                "suggestedAgents": ["explore"],
            },
        )

        async def dispatched():
            return bool(deps._runs)

        assert await _poll(dispatched), "no run was created from the observer objective"
        run = next(iter(deps._runs.values()))
        assert run.agent_ref.startswith("explore@")
        status = await handle.query(MetaAgentWorkflow.get_status)
        assert status["backlog"] == 0


async def test_meta_dead_letters_unresolvable_objective(env, deps):
    """An unresolvable objective must not crash the workflow task — it goes to
    a dead-letter list with a warning and the loop keeps going."""
    async with make_worker(env, [MetaAgentWorkflow, AgentRunWorkflow, EvalWorkflow]):
        handle = await env.client.start_workflow(
            MetaAgentWorkflow.run, id=META_WORKFLOW_ID, task_queue=TASK_QUEUE_CONTROL
        )
        # No suggestedAgents and no default mapping for this type.
        await handle.signal(
            MetaAgentWorkflow.new_objective,
            {"id": "obj_DL1", "type": "skill-gen", "repo": "r", "title": "t"},
        )
        # suggestedAgents naming an agent that resolves to no spec document.
        await handle.signal(
            MetaAgentWorkflow.new_objective,
            {
                "id": "obj_DL2",
                "type": "explore",
                "repo": "r",
                "title": "t",
                "suggestedAgents": ["no-such-agent"],
            },
        )

        async def dead_lettered():
            dl = await handle.query(MetaAgentWorkflow.get_dead_letter)
            return len(dl) == 2

        assert await _poll(dead_lettered), "objectives were not dead-lettered"
        dl = await handle.query(MetaAgentWorkflow.get_dead_letter)
        assert {d["objective"]["id"] for d in dl} == {"obj_DL1", "obj_DL2"}
        assert all(d["reason"] for d in dl)
        # The workflow is still healthy: it can keep dispatching.
        status = await handle.query(MetaAgentWorkflow.get_status)
        assert status["backlog"] == 0
        assert deps._runs == {}


# --- backlog dedupe by objective id (observer ids are deterministic) ---


async def test_meta_dedupes_objectives_by_id(env, deps):
    """The same objective id signalled repeatedly — in the same cycle or a
    later observer cycle — must be dispatched at most once."""
    objective = {
        "id": "obj_DUP1",
        "type": "explore",
        "repo": "bakudo",
        "title": "dedupe test",
        "suggestedAgents": ["explore"],
    }
    async with make_worker(env, [MetaAgentWorkflow, AgentRunWorkflow, EvalWorkflow]):
        handle = await env.client.start_workflow(
            MetaAgentWorkflow.run, id=META_WORKFLOW_ID, task_queue=TASK_QUEUE_CONTROL
        )
        # Hold dispatch so in-backlog dedupe is observable.
        await handle.signal(MetaAgentWorkflow.pause_autonomy)
        await handle.signal(MetaAgentWorkflow.new_objective, objective)
        await handle.signal(MetaAgentWorkflow.new_objective, objective)
        backlog = await handle.query(MetaAgentWorkflow.get_backlog)
        assert [o["id"] for o in backlog] == ["obj_DUP1"], "backlog must dedupe by id"

        await handle.signal(MetaAgentWorkflow.resume_autonomy)

        async def processed():
            status = await handle.query(MetaAgentWorkflow.get_status)
            return status["processed_objectives"] == 1

        assert await _poll(processed)

        # A later cycle re-emitting the same id must be a no-op.
        await handle.signal(MetaAgentWorkflow.new_objective, objective)
        await asyncio.sleep(0.5)
        status = await handle.query(MetaAgentWorkflow.get_status)
        assert status["backlog"] == 0
        assert len(deps._runs) == 1, "the duplicate id was dispatched again"


# --- run-completion loop (TMP-5) ---


async def test_completed_child_run_drains_meta_active_runs(env, deps):
    """AgentRunWorkflow signals run_completed back to the meta workflow, so
    active_runs drains instead of growing forever across Continue-As-New."""
    async with make_worker(env, [MetaAgentWorkflow, AgentRunWorkflow, EvalWorkflow]):
        handle = await env.client.start_workflow(
            MetaAgentWorkflow.run, id=META_WORKFLOW_ID, task_queue=TASK_QUEUE_CONTROL
        )
        await handle.signal(
            MetaAgentWorkflow.new_objective,
            {
                "id": "obj_DRAIN1",
                "type": "explore",
                "repo": "bakudo",
                "title": "drain test",
                "suggestedAgents": ["explore"],
            },
        )

        async def drained():
            status = await handle.query(MetaAgentWorkflow.get_status)
            return status["active_runs"] == [] and status["processed_objectives"] == 1

        assert await _poll(drained), "active_runs never drained after child completion"
        # And the child really ran to completion through the ledger.
        run = next(iter(deps._runs.values()))
        assert run.phase.value == "completed"


# --- retry exhaustion leaves a terminal ledger record (TMP-10) ---


async def test_activity_exhaustion_writes_terminal_failed_phase(env, deps, monkeypatch):
    """When the sandbox activity exhausts its retries the workflow fails, but
    the ledger must not be left at agent_running forever: a terminal failed
    phase + finished event land first."""
    from temporalio.client import WorkflowFailureError

    def broken_sandbox(bundle):
        raise RuntimeError("sandbox exploded")

    monkeypatch.setattr(_impl.DEPS, "sandbox", broken_sandbox)
    spec = _impl.load_agent_spec("explore")
    assert spec is not None

    from bakudo.temporal.shared import AgentRunInput

    async with make_worker(env, [AgentRunWorkflow, EvalWorkflow]):
        with pytest.raises(WorkflowFailureError):
            await env.client.execute_workflow(
                AgentRunWorkflow.run,
                AgentRunInput(
                    run_id="run_FAIL1",
                    objective={"id": "obj_FAIL1", "type": "explore", "repo": "r",
                               "title": "t"},
                    agent_spec=spec,
                ),
                id="run-run_FAIL1",
                task_queue=TASK_QUEUE_CONTROL,
            )

        run = deps.get_run("run_FAIL1")
        assert run is not None
        assert run.phase.value == "failed", f"ledger stuck at {run.phase.value!r}"
        kinds = [e.event_type for e in deps.events("run_FAIL1")]
        assert kinds.count("finished") == 1


# --- one crashed optimize attempt must not fail the round (TMP-11) ---


async def test_crashed_optimize_attempt_becomes_feedback_not_failure(env, deps, monkeypatch):
    from bakudo.temporal.shared import OptimizeInput

    def scripted_sandbox(bundle):
        title = bundle.objective.title
        if "[optimize-scout]" in title:
            out = stub_sandbox(bundle)
            out.result["proposed_followups"] = ["approach A", "approach B"]
            return out
        if "[optimize-attempt 1]" in title:
            raise RuntimeError("attempt sandbox crashed")
        return stub_sandbox(bundle)

    monkeypatch.setattr(_impl.DEPS, "sandbox", scripted_sandbox)
    scout_spec = _impl.load_agent_spec("optimize-scout")
    attempt_spec = _impl.load_agent_spec("optimize-attempt")
    assert scout_spec and attempt_spec

    async with make_worker(
        env,
        [
            OptimizationWorkflow,
            PerformanceComparisonWorkflow,
            AgentRunWorkflow,
            EvalWorkflow,
        ],
    ):
        out = await env.client.execute_workflow(
            OptimizationWorkflow.run,
            OptimizeInput(
                objective={
                    "id": "obj_OPT1", "type": "optimize", "repo": "bakudo",
                    "title": "opt", "constraints": {},
                    "performance": _performance_contract(),
                },
                scout_spec=scout_spec,
                attempt_spec=attempt_spec,
                max_rounds=1,
                max_approaches=2,
            ),
            id="optimize-obj_OPT1",
            task_queue=TASK_QUEUE_CONTROL,
        )

    # The workflow completes (no-change), the crash surfacing as feedback.
    assert out["status"] == "no-change"
    assert out["rounds_used"] == 1
    assert any("crash" in fb for fb in out.get("feedback", [])), out.get("feedback")


async def test_blocked_scout_without_followups_is_scout_failed(env, deps, monkeypatch):
    """Issue #27 loop hole (workflow mirror): a blocked scout with empty
    followups must surface as scout-failed, never as 'no-change'."""
    from bakudo.temporal.shared import OptimizeInput

    def blocked_scout_sandbox(bundle):
        out = stub_sandbox(bundle)
        if "[optimize-scout]" in bundle.objective.title:
            out.result["status"] = "blocked"
            out.result["blocked_reasons"] = ["budget:tool_calls"]
            out.result["summary"] = "halted at the tool-call ceiling"
        return out

    monkeypatch.setattr(_impl.DEPS, "sandbox", blocked_scout_sandbox)
    scout_spec = _impl.load_agent_spec("optimize-scout")
    attempt_spec = _impl.load_agent_spec("optimize-attempt")
    assert scout_spec and attempt_spec

    async with make_worker(
        env,
        [
            OptimizationWorkflow,
            PerformanceComparisonWorkflow,
            AgentRunWorkflow,
            EvalWorkflow,
        ],
    ):
        out = await env.client.execute_workflow(
            OptimizationWorkflow.run,
            OptimizeInput(
                objective={
                    "id": "obj_OPT2", "type": "optimize", "repo": "bakudo",
                    "title": "opt", "constraints": {},
                    "performance": _performance_contract(),
                },
                scout_spec=scout_spec,
                attempt_spec=attempt_spec,
                max_rounds=1,
                max_approaches=2,
            ),
            id="optimize-obj_OPT2",
            task_queue=TASK_QUEUE_CONTROL,
        )

    assert out["status"] == "scout-failed"
    assert "halted at the tool-call ceiling" in out["reason"]


def _optimize_scripted_sandbox(diff="--- a/dedupe.py\n+++ b/dedupe.py\n"):
    def scripted(bundle):
        out = stub_sandbox(bundle)
        if "[optimize-scout]" in bundle.objective.title:
            out.result["proposed_followups"] = ["use a set"]
        else:
            out.result["tests_run"] = [{"command": "pytest -q", "status": "passed"}]
            out.result["changed_files"] = ["dedupe.py"]
            out.diff = diff
        return out

    return scripted


def _optimize_input(_impl_mod):
    from bakudo.temporal.shared import OptimizeInput

    return OptimizeInput(
        objective={
            "id": "obj_OPT3", "type": "optimize", "repo": "bakudo",
            "title": "opt", "acceptanceCriteria": ["All existing tests pass"],
            "constraints": {},
            "performance": _performance_contract(),
        },
        scout_spec=_impl_mod.load_agent_spec("optimize-scout"),
        attempt_spec=_impl_mod.load_agent_spec("optimize-attempt"),
        max_rounds=1,
        max_approaches=1,
    )


async def test_optimize_workflow_requires_trusted_comparison(env, deps, monkeypatch):
    """The candidate is independently measured before it can be selected."""
    comparisons = []

    def compare(inp, cancel_event=None):
        del cancel_event
        comparisons.append(inp)
        return _trusted_performance_comparison(inp)

    monkeypatch.setattr(_impl.DEPS, "sandbox", _optimize_scripted_sandbox())
    monkeypatch.setattr(_impl, "run_performance_comparison", compare)

    async with make_worker(
        env,
        [
            OptimizationWorkflow,
            PerformanceComparisonWorkflow,
            AgentRunWorkflow,
            EvalWorkflow,
        ],
    ):
        out = await env.client.execute_workflow(
            OptimizationWorkflow.run, _optimize_input(_impl),
            id="optimize-obj_OPT3", task_queue=TASK_QUEUE_CONTROL,
        )

    assert out["status"] == "improved"
    assert out["comparison_id"] == comparisons[0].comparison_id
    assert comparisons[0].candidate_patch == "--- a/dedupe.py\n+++ b/dedupe.py\n"


async def test_optimize_workflow_rejects_non_improving_comparison(env, deps, monkeypatch):
    monkeypatch.setattr(_impl.DEPS, "sandbox", _optimize_scripted_sandbox())
    monkeypatch.setattr(
        _impl,
        "run_performance_comparison",
        lambda inp, _cancel=None: _trusted_performance_comparison(inp, effect=0.0),
    )

    async with make_worker(
        env,
        [
            OptimizationWorkflow,
            PerformanceComparisonWorkflow,
            AgentRunWorkflow,
            EvalWorkflow,
        ],
    ):
        out = await env.client.execute_workflow(
            OptimizationWorkflow.run, _optimize_input(_impl),
            id="optimize-obj_OPT3b", task_queue=TASK_QUEUE_CONTROL,
        )

    assert out["status"] == "no-change"


# --- Continue-As-New must not kill in-flight runs (TMP-6) ---


async def test_continue_as_new_abandons_in_flight_children(env, deps, monkeypatch):
    """Children are started with ParentClosePolicy.ABANDON, so the meta
    workflow rolling its history does not terminate a sandbox mid-run."""
    from temporalio.client import WorkflowExecutionStatus

    def slow_sandbox(bundle):
        time.sleep(1.5)
        return stub_sandbox(bundle)

    monkeypatch.setattr(_impl.DEPS, "sandbox", slow_sandbox)

    async with make_worker(env, [MetaAgentWorkflow, AgentRunWorkflow, EvalWorkflow]):
        handle = await env.client.start_workflow(
            MetaAgentWorkflow.run,
            MetaState(continue_as_new_threshold=1),
            id=META_WORKFLOW_ID,
            task_queue=TASK_QUEUE_CONTROL,
        )
        first_run_id = (await handle.describe()).run_id
        await handle.signal(
            MetaAgentWorkflow.new_objective,
            {
                "id": "obj_CAN1",
                "type": "explore",
                "repo": "bakudo",
                "title": "in-flight during continue-as-new",
                "suggestedAgents": ["explore"],
            },
        )

        # Wait until the first meta run has rolled over via Continue-As-New.
        pinned = env.client.get_workflow_handle(META_WORKFLOW_ID, run_id=first_run_id)

        async def rolled_over():
            desc = await pinned.describe()
            return desc.status == WorkflowExecutionStatus.CONTINUED_AS_NEW

        assert await _poll(rolled_over), "meta workflow never continued-as-new"

        # The dispatched child must have survived the parent's rollover.
        status = await handle.query(MetaAgentWorkflow.get_status)
        assert len(status["active_runs"]) == 1
        child = env.client.get_workflow_handle(f"run-{status['active_runs'][0]}")
        desc = await child.describe()
        assert desc.status in (
            WorkflowExecutionStatus.RUNNING,
            WorkflowExecutionStatus.COMPLETED,
        ), f"child was {desc.status.name} — killed by parent close policy"

        # The test server is lenient about parent-close semantics, so also pin
        # the policy the child was actually started with at the history level.
        from temporalio.api.enums.v1 import ParentClosePolicy as ProtoPolicy

        history = await pinned.fetch_history()
        initiated = [
            e.start_child_workflow_execution_initiated_event_attributes
            for e in history.events
            if e.HasField("start_child_workflow_execution_initiated_event_attributes")
        ]
        assert initiated, "no child workflow was initiated by the meta run"
        assert all(
            attrs.parent_close_policy == ProtoPolicy.PARENT_CLOSE_POLICY_ABANDON
            for attrs in initiated
        ), "children must be started with ParentClosePolicy.ABANDON (TMP-6)"


# --- governance that actually governs (TMP-17/18/19/20) ---


def _meta_with_state(**state_kwargs):
    """A MetaAgentWorkflow instance for unit-testing the pure gating helpers
    (no Temporal env needed — these methods touch no workflow.* APIs)."""
    wf = MetaAgentWorkflow()
    for k, v in state_kwargs.items():
        setattr(wf._state, k, v)
    return wf


def test_dispatch_candidate_respects_global_concurrency_cap():
    wf = _meta_with_state(max_concurrent_runs=2)
    wf._backlog = [{"id": "o1", "type": "explore"}]
    wf._state.active_runs = ["r1", "r2"]
    wf._state.active_run_roles = {"r1": "explore", "r2": "explore"}
    assert wf._dispatch_candidate() is None  # global cap reached
    wf._state.active_runs = ["r1"]
    wf._state.active_run_roles = {"r1": "explore"}
    assert wf._dispatch_candidate()["id"] == "o1"


def test_dispatch_candidate_respects_per_role_cap_without_head_of_line_block():
    """A capped role must not block an unrelated objective behind it while
    global capacity remains (TMP-17)."""
    wf = _meta_with_state(max_concurrent_runs=5, role_concurrency={"add-feature": 1})
    wf._state.active_runs = ["r1"]
    wf._state.active_run_roles = {"r1": "add-feature"}
    wf._backlog = [
        {"id": "blocked", "type": "add-feature"},   # role at cap
        {"id": "ok", "type": "explore"},            # unrelated, has capacity
    ]
    assert wf._dispatch_candidate()["id"] == "ok"


def test_dispatch_candidate_blocks_when_budget_exhausted():
    wf = _meta_with_state(budget_usd_remaining=0.0)
    wf._backlog = [{"id": "o1", "type": "explore"}]
    assert wf._dispatch_candidate() is None
    wf._state.budget_usd_remaining = 5.0
    assert wf._dispatch_candidate()["id"] == "o1"


def test_dispatch_candidate_blocks_while_paused_or_observing():
    wf = _meta_with_state()
    wf._backlog = [{"id": "o1", "type": "explore"}]
    wf._paused = True
    assert wf._dispatch_candidate() is None
    wf._paused = False
    wf._state.mode = "observe"
    assert wf._dispatch_candidate() is None
    wf._state.mode = "sandbox-autonomous"
    assert wf._dispatch_candidate()["id"] == "o1"


def test_run_completed_decrements_priced_budget_and_drains_state():
    wf = _meta_with_state(budget_usd_remaining=10.0, usd_per_1k_tokens=2.0)
    wf._state.active_runs = ["r1"]
    wf._state.active_run_roles = {"r1": "explore"}
    wf._state.active_run_started = {"r1": "2026-08-15T00:00:00+00:00"}
    wf.run_completed("r1", tokens_used=1000)
    assert wf._state.budget_usd_remaining == 8.0  # 1000/1000 * 2.0
    assert wf._state.active_runs == []
    assert wf._state.active_run_roles == {} and wf._state.active_run_started == {}


def test_run_completed_default_rate_is_a_noop_on_budget():
    wf = _meta_with_state(budget_usd_remaining=10.0)  # rate defaults to 0.0
    wf._state.active_runs = ["r1"]
    wf.run_completed("r1", tokens_used=100000)
    assert wf._state.budget_usd_remaining == 10.0


def test_stale_active_runs_selects_only_expired_entries():
    from datetime import UTC, datetime, timedelta

    now = datetime(2026, 8, 15, 12, 0, 0, tzinfo=UTC)
    wf = _meta_with_state(active_run_ttl_hours=3.0)
    wf._state.active_run_started = {
        "fresh": (now - timedelta(hours=1)).isoformat(),
        "stale": (now - timedelta(hours=4)).isoformat(),
    }
    assert wf._stale_active_runs(now) == ["stale"]


def test_drop_active_run_clears_all_tracking_maps():
    wf = _meta_with_state()
    wf._state.active_runs = ["fresh", "stale"]
    wf._state.active_run_roles = {"fresh": "explore", "stale": "explore"}
    wf._state.active_run_started = {"fresh": "t1", "stale": "t2"}
    wf._drop_active_run("stale")
    assert wf._state.active_runs == ["fresh"]
    assert "stale" not in wf._state.active_run_roles
    assert "stale" not in wf._state.active_run_started


def test_spec_name_version_extracts_or_raises_malformed():
    from bakudo.temporal.workflows import _MalformedSpec

    good = {"agent_spec": {"metadata": {"name": "explore", "version": 3}}}
    assert AgentRunWorkflow._spec_name_version(good) == ("explore", 3)
    for bad in (
        {"agent_spec": {"metadata": {"version": 1}}},   # no name
        {"agent_spec": {"metadata": {"name": "x"}}},     # no version
        {"agent_spec": {}},                              # no metadata
        {},                                              # no agent_spec
    ):
        with pytest.raises(_MalformedSpec):
            AgentRunWorkflow._spec_name_version(bad)


async def test_meta_budget_zero_blocks_dispatch(env, deps):
    """change_budget(0) must actually halt dispatch — the budget knob is a
    real kill-switch, not decorative (TMP-17)."""
    async with make_worker(env, [MetaAgentWorkflow, AgentRunWorkflow, EvalWorkflow]):
        handle = await env.client.start_workflow(
            MetaAgentWorkflow.run, id=META_WORKFLOW_ID, task_queue=TASK_QUEUE_CONTROL
        )
        await handle.execute_update(MetaAgentWorkflow.change_budget, 0.0)
        await handle.signal(
            MetaAgentWorkflow.new_objective,
            {"id": "obj_B0", "type": "explore", "repo": "r", "title": "t",
             "suggestedAgents": ["explore"]},
        )
        await asyncio.sleep(0.5)
        status = await handle.query(MetaAgentWorkflow.get_status)
        budget = await handle.query(MetaAgentWorkflow.get_budget_state)
        assert status["backlog"] == 1, "objective must stay queued while budget is 0"
        assert deps._runs == {}, "no run may dispatch on an exhausted budget"
        assert budget["budget_exhausted"] is True

        # Restoring the budget releases the queued objective.
        await handle.execute_update(MetaAgentWorkflow.change_budget, 50.0)

        async def dispatched():
            return bool(deps._runs)

        assert await _poll(dispatched), "dispatch must resume once budget is restored"


async def test_meta_routes_optimize_objective_into_optimization_workflow(
    env, deps, monkeypatch
):
    """An optimize objective must drive OptimizationWorkflow (scout->attempt->
    verify), not a single AgentRunWorkflow (TMP-19); and the loop notifies
    run_completed so the meta active_runs drains."""
    monkeypatch.setattr(_impl.DEPS, "sandbox", _optimize_scripted_sandbox())

    async with make_worker(
        env,
        [
            MetaAgentWorkflow,
            OptimizationWorkflow,
            PerformanceComparisonWorkflow,
            AgentRunWorkflow,
            EvalWorkflow,
        ],
    ):
        handle = await env.client.start_workflow(
            MetaAgentWorkflow.run, id=META_WORKFLOW_ID, task_queue=TASK_QUEUE_CONTROL
        )
        await handle.signal(
            MetaAgentWorkflow.new_objective,
            {
                "id": "obj_OPTR", "type": "optimize", "repo": "bakudo",
                "title": "optimize the thing",
                "acceptanceCriteria": ["All existing tests pass"],
                "constraints": {},
                "performance": _performance_contract(),
            },
        )

        async def drained_after_optimize():
            status = await handle.query(MetaAgentWorkflow.get_status)
            return status["active_runs"] == [] and status["processed_objectives"] == 1

        assert await _poll(drained_after_optimize, timeout=25.0), (
            "optimize loop never completed / meta active_runs never drained"
        )
        # Routing proof: only the scout->attempt loop produces an
        # `optimize-attempt` run. A single AgentRunWorkflow (the old behaviour)
        # would run the scout alone.
        refs = {r.agent_ref.split("@")[0] for r in deps._runs.values()}
        assert "optimize-attempt" in refs, (
            f"optimize objective did not fan out into the loop; runs={refs}"
        )


async def test_cancel_signal_during_sandbox_records_cancelled(env, monkeypatch):
    """A cancel signal that arrives while the sandbox activity is in flight
    must cancel it and record a terminal `cancelled` phase (TMP-21), not be
    ignored until the multi-hour sandbox returns."""
    import threading

    ledger = InMemoryLedger()
    release = threading.Event()

    def blocking_sandbox(bundle):
        release.wait(timeout=10)  # held until the test releases it
        return stub_sandbox(bundle)

    monkeypatch.setattr(_impl.DEPS, "ledger", ledger)
    monkeypatch.setattr(_impl.DEPS, "sandbox", blocking_sandbox)

    async with make_worker(env, [AgentRunWorkflow, EvalWorkflow]):
        from bakudo.temporal.shared import AgentRunInput

        handle = await env.client.start_workflow(
            AgentRunWorkflow.run,
            AgentRunInput(
                run_id="run_CANCEL1",
                objective={"id": "obj_C", "type": "explore", "repo": "r", "title": "t"},
                agent_spec=_impl.load_agent_spec("explore"),
            ),
            id="run-run_CANCEL1", task_queue=TASK_QUEUE_CONTROL,
        )

        async def in_sandbox():
            run = ledger.get_run("run_CANCEL1")
            return run is not None and run.phase.value == "agent_running"

        assert await _poll(in_sandbox), "run never reached the agent_running phase"
        await handle.signal(AgentRunWorkflow.cancel)

        out = await handle.result()
        assert out.phase == "cancelled"
        run = ledger.get_run("run_CANCEL1")
        assert run.phase.value == "cancelled"
    release.set()  # let the leaked activity thread finish


async def test_meta_optimize_charges_accumulated_tokens_to_budget(env, deps, monkeypatch):
    """TMP-24: an optimize loop's scout/attempt child runs are parented by
    OptimizationWorkflow (so their own _notify_meta is skipped); the loop must
    still charge their accumulated tokens against the meta budget, or optimize
    work would spend against a zero charge."""
    base = _optimize_scripted_sandbox()

    def scripted_with_tokens(bundle):
        out = base(bundle)
        out.result.setdefault("metrics", {})["tokens_used"] = 1000
        return out

    monkeypatch.setattr(_impl.DEPS, "sandbox", scripted_with_tokens)

    async with make_worker(
        env,
        [
            MetaAgentWorkflow,
            OptimizationWorkflow,
            PerformanceComparisonWorkflow,
            AgentRunWorkflow,
            EvalWorkflow,
        ],
    ):
        handle = await env.client.start_workflow(
            MetaAgentWorkflow.run, id=META_WORKFLOW_ID, task_queue=TASK_QUEUE_CONTROL
        )
        await handle.execute_update(MetaAgentWorkflow.change_budget, 100.0)
        await handle.execute_update(MetaAgentWorkflow.change_token_price, 1.0)  # $1/1k
        await handle.signal(
            MetaAgentWorkflow.new_objective,
            {
                "id": "obj_OPTBUD", "type": "optimize", "repo": "bakudo",
                "title": "optimize with cost",
                "acceptanceCriteria": ["All existing tests pass"],
                "constraints": {},
                "performance": _performance_contract(),
            },
        )

        async def drained():
            status = await handle.query(MetaAgentWorkflow.get_status)
            return status["active_runs"] == [] and status["processed_objectives"] == 1

        assert await _poll(drained, timeout=25.0)
        budget = await handle.query(MetaAgentWorkflow.get_budget_state)
        # scout + >=1 attempt, each 1000 tokens at $1/1k => at least $2 charged
        # (the pre-fix behaviour charged exactly $0).
        assert budget["budget_usd_remaining"] <= 98.0, budget
