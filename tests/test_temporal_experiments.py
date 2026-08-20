"""TrialWorkflow + ExperimentWorkflow tests (Task 11), mirroring
``tests/test_temporal_workflows.py``'s time-skipping-env / ``Deps``-stubbing
patterns.

Controller ruling R1: ``select_tasks``/the task source are
filesystem I/O, so they never run in workflow code -- ``resolve_experiment_
tasks``, ``provision_trial``, ``evaluate_trial_verifier``, and
``analyze_experiment`` are stubbed at the ``_impl`` module-function boundary
here (the same boundary the activity wrappers call through), the same way
``test_temporal_workflows.py`` stubs ``_impl.DEPS.sandbox`` -- these tests
exercise workflow orchestration (fan-out, concurrency, crash handling,
persistence), not the trial/verifier-eval internals Tasks 6/7 already cover.
"""

from __future__ import annotations

import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
from temporalio.exceptions import ApplicationError
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import Worker

from bakudo.abox.runner import AboxOutcome
from bakudo.performance.models import (
    IntegrityResult,
    MeasurementRecord,
    MetricDirection,
    MetricEstimator,
    MetricSampleSet,
    MetricUnit,
    RecordStatus,
)
from bakudo.performance.pins import EnvironmentPin, RevisionPin, WorkloadPin
from bakudo.registry import InMemoryLedger
from bakudo.temporal import _impl
from bakudo.temporal.activities import ALL_ACTIVITIES
from bakudo.temporal.shared import (
    TASK_QUEUE_CONTROL,
    TASK_QUEUE_RUNS,
    ExperimentInput,
    PerformanceWorkflowResult,
    TrialInput,
)
from bakudo.temporal.workflows import (
    AgentRunWorkflow,
    EvalWorkflow,
    ExperimentWorkflow,
    PerformanceMeasurementWorkflow,
    TrialWorkflow,
)


def stub_sandbox(bundle):
    """A successful sandbox outcome with a schema-valid result (mirrors
    test_temporal_workflows.py's stub)."""
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
            "changed_files": ["fix.py"],
        },
        diff="--- a/fix.py\n+++ b/fix.py\n",
    )


@pytest.fixture
def deps(monkeypatch):
    ledger = InMemoryLedger()
    monkeypatch.setattr(_impl.DEPS, "ledger", ledger)
    monkeypatch.setattr(_impl.DEPS, "sandbox", stub_sandbox)
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


def _objective_doc(task_ref: str) -> dict:
    return {
        "id": f"objd_{task_ref.replace('@', '_')}",
        "type": "explore",
        "repo": "bakudo",
        "title": f"trial: {task_ref}",
        "description": "",
        "acceptanceCriteria": [],
        "constraints": {},
        "suggestedAgents": [],
        "dependsOn": [],
        "status": "ready",
    }


def _provision_stub(fail_for: tuple[str, str] | None = None):
    """A stand-in for ``_impl.provision_trial`` good enough to drive a real
    ``AgentRunWorkflow`` (a schema-valid objective + a real, on-disk agent
    spec) without touching the task-source/fixture filesystem."""

    agent_spec_doc = _impl.load_agent_spec("explore")
    assert agent_spec_doc is not None

    def _stub(input: dict) -> dict:
        if fail_for is not None and (input["task"], input["agent"]) == fail_for:
            raise ApplicationError("provisioning exploded", non_retryable=True)
        name, _, version_s = input["task"].partition("@")
        version = int(version_s) if version_s else 1
        return {
            "repo_path": "/tmp/bakudo-trial-stub",
            "objective": _objective_doc(input["task"]),
            "agent_spec": agent_spec_doc,
            "agent_ref": input["agent"],
            "task_pin": {
                "source_uri": "file:///benchmark-corpus",
                "corpus_revision": "test-revision",
                "name": name,
                "version": version,
                "bundle_digest": f"sha256:bundle-{name}",
                "verifier_digest": f"sha256:verifier-{name}",
            },
            "limits": {},
            "network": "none",
            "timeout_seconds": 60,
            "runtime_pins": {
                "bakudo": "0.0.0-stub",
                "model_id": agent_spec_doc["model"]["modelId"],
                "sandbox_profile": agent_spec_doc["sandbox"]["profile"],
            },
        }

    return _stub


def _verifier_stub(input: dict) -> dict:
    return {
        "f2p_rate": 1.0,
        "p2p_rate": 1.0,
        "reward": {"fail_to_pass_rate": 1.0, "pass_to_pass_rate": 1.0},
        "detail": "stubbed verifier eval",
        "expected_status": "success",
        "actual_status": input.get("actual_status"),
        "status_match": True,
        "integrity": {
            "verifier_input_violation": False,
            "denied_action_violation": False,
            "scope_violation": False,
            "change_limit_violation": False,
            "details": {},
        },
    }


def _tasks_stub(input: dict) -> dict:
    """Identity arm resolution (every test spec here already uses pinned
    refs) -- ``resolvedArms`` is still built from ``input["spec"]`` so a
    test can also exercise Finding #4's resolution contract by asserting on
    it directly, without special-casing this stub further."""
    spec = input["spec"]
    subject = spec["subject"]
    arm_refs = [subject["baseline"], *subject.get("candidates", [])]

    def descriptor(name: str, digest: str) -> dict:
        return {
            "name": name,
            "version": 1,
            "family": "debugging",
            "paired_task": None,
            "task_pin": {
                "source_uri": "file:///benchmark-corpus",
                "corpus_revision": "test-revision",
                "name": name,
                "version": 1,
                "bundle_digest": f"sha256:{digest}",
                "verifier_digest": f"sha256:verifier-{digest}",
            },
        }

    return {
        "tasks": [
            descriptor("task-a", "da"),
            descriptor("task-b", "db"),
        ],
        "resolvedArms": {ref: ref for ref in arm_refs},
    }


@pytest.fixture
def stub_trial_activities(monkeypatch):
    """Stub the filesystem-bound trial activities (provision/verifier-eval),
    leaving persist_trial/persist_experiment real so assertions can read the
    ledger directly."""
    monkeypatch.setattr(_impl, "provision_trial", _provision_stub())
    monkeypatch.setattr(_impl, "evaluate_trial_verifier", _verifier_stub)
    return None


def _experiment_spec(name: str = "exp-test", candidates: list[str] | None = None) -> dict:
    return {
        "apiVersion": "bakudo.ai/v1alpha1",
        "kind": "ExperimentSpec",
        "metadata": {"name": name},
        "subject": {
            "kind": "agent-spec",
            "baseline": "explore@1",
            "candidates": candidates if candidates is not None else ["explore@1"],
            "taskSelector": {"count": 20},
        },
        "repetitions": 1,
    }


# --- TrialWorkflow ---


async def test_trial_workflow_happy_path(env, deps, monkeypatch):
    calls = {"provision": 0, "verifier": 0}

    provision_impl = _provision_stub()

    def counted_provision(input: dict) -> dict:
        calls["provision"] += 1
        return provision_impl(input)

    def counted_verifier(input: dict) -> dict:
        calls["verifier"] += 1
        return _verifier_stub(input)

    monkeypatch.setattr(_impl, "provision_trial", counted_provision)
    monkeypatch.setattr(_impl, "evaluate_trial_verifier", counted_verifier)

    async with make_worker(env, [TrialWorkflow, AgentRunWorkflow, EvalWorkflow]):
        out = await env.client.execute_workflow(
            TrialWorkflow.run,
            TrialInput(task="task-a@1", agent="explore@1", seed=7),
            id="trial-run_HAPPY1",
            task_queue=TASK_QUEUE_CONTROL,
        )

    assert calls == {"provision": 1, "verifier": 1}
    assert out["status"] == "completed"
    assert out["agent_ref"] == "explore@1"
    assert out["task"]["name"] == "task-a"
    assert out["evaluation"]["f2p_rate"] == 1.0
    assert out["seed"] == 7

    # Runtime pins remain distinct from immutable task provenance.
    assert out["task"]["corpus_revision"] == "test-revision"
    assert out["runtime_pins"]["bakudo"] == "0.0.0-stub"
    assert out["runtime_pins"]["model_id"]
    assert out["runtime_pins"]["sandbox_profile"]

    # Finding #3: the AgentRunWorkflow child's scorecard must not be
    # silently dropped from evaluation.
    assert out["evaluation"]["scorecard"] is not None

    recorded = deps.get_trial(out["id"])
    assert recorded is not None
    assert recorded.status == "completed"
    assert recorded.agent_ref == "explore@1"
    assert recorded.task.model_dump(mode="json") == out["task"]
    assert recorded.runtime_pins == out["runtime_pins"]
    assert recorded.evaluation.get("scorecard") is not None


# --- Finding #3: Temporal-path metrics keys must match the sync run_trial
# path (tokens/tool_calls/duration_s), not the guest's raw self-report ---


def stub_sandbox_with_raw_metrics(bundle):
    """A sandbox outcome whose result carries the guest's raw in-guest
    metrics keys (tokens_used/tool_calls/model_calls, per
    strands_tools.ToolContext.observability()/runner/main.py) plus a nonzero
    ``runtime_seconds`` -- exactly what a real abox/local sandbox produces,
    and what TrialWorkflow must normalize into tokens/tool_calls/duration_s."""
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
            "changed_files": ["fix.py"],
            "metrics": {"tokens_used": 4321.0, "tool_calls": 6.0, "model_calls": 2.0},
        },
        diff="--- a/fix.py\n+++ b/fix.py\n",
        denied_commands=[{"command": "blocked-command", "reason": "policy"}],
        runtime_seconds=12.5,
    )


async def test_trial_workflow_normalizes_temporal_metrics_keys(env, monkeypatch):
    ledger = InMemoryLedger()
    verifier_input: dict = {}

    def capture_verifier(input: dict) -> dict:
        verifier_input.update(input)
        return _verifier_stub(input)

    monkeypatch.setattr(_impl.DEPS, "ledger", ledger)
    monkeypatch.setattr(_impl.DEPS, "sandbox", stub_sandbox_with_raw_metrics)
    monkeypatch.setattr(_impl, "provision_trial", _provision_stub())
    monkeypatch.setattr(_impl, "evaluate_trial_verifier", capture_verifier)

    async with make_worker(env, [TrialWorkflow, AgentRunWorkflow, EvalWorkflow]):
        out = await env.client.execute_workflow(
            TrialWorkflow.run,
            TrialInput(task="task-a@1", agent="explore@1", seed=11),
            id="trial-run_METRICS1",
            task_queue=TASK_QUEUE_CONTROL,
        )

    assert out["metrics"]["tokens"] == 4321.0, out["metrics"]
    assert out["metrics"]["tool_calls"] == 6.0, out["metrics"]
    assert out["metrics"]["duration_s"] == 12.5, out["metrics"]
    assert verifier_input["denied_commands"] == ["blocked-command"]

    recorded = ledger.get_trial(out["id"])
    assert recorded is not None
    assert recorded.metrics["tokens"] == 4321.0
    assert recorded.metrics["duration_s"] == 12.5


# --- ExperimentWorkflow ---


async def test_experiment_workflow_fans_out(env, deps, stub_trial_activities, monkeypatch):
    analyzed: dict = {}

    def fake_analyze(input: dict) -> dict:
        trials = deps.list_trials(input["experiment_id"])
        analyzed["trial_count"] = len(trials)
        analyzed["experiment_id"] = input["experiment_id"]
        return {"experimentId": input["experiment_id"], "trialsSeen": len(trials)}

    monkeypatch.setattr(_impl, "resolve_experiment_tasks", _tasks_stub)
    monkeypatch.setattr(_impl, "analyze_experiment", fake_analyze)

    async with make_worker(
        env, [ExperimentWorkflow, TrialWorkflow, AgentRunWorkflow, EvalWorkflow]
    ):
        result = await env.client.execute_workflow(
            ExperimentWorkflow.run,
            ExperimentInput(spec=_experiment_spec()),
            id="experiment-run_FANOUT1",
            task_queue=TASK_QUEUE_CONTROL,
        )

    # 2 tasks x 1 repetition x 2 arms (baseline + 1 candidate) -> 4 trials.
    assert analyzed["trial_count"] == 4
    assert result["trialsSeen"] == 4

    experiment = deps.get_experiment(analyzed["experiment_id"])
    assert experiment is not None
    assert experiment["status"] == "completed"
    assert experiment["result"] == result


async def test_experiment_child_crash_recorded(env, deps, monkeypatch):
    # One (task, agent) cell -- the candidate arm on task-b -- fails
    # to provision; every other cell succeeds. Distinct baseline/candidate
    # refs (the stub doesn't care that "explore-candidate@1" isn't a real
    # on-disk spec -- it never loads one) isolate exactly one of the 4
    # planned trials to crash.
    monkeypatch.setattr(
        _impl,
        "provision_trial",
        _provision_stub(fail_for=("task-b@1", "explore-candidate@1")),
    )
    monkeypatch.setattr(_impl, "evaluate_trial_verifier", _verifier_stub)
    monkeypatch.setattr(_impl, "resolve_experiment_tasks", _tasks_stub)

    seen: dict = {}

    def fake_analyze(input: dict) -> dict:
        trials = deps.list_trials(input["experiment_id"])
        seen["experiment_id"] = input["experiment_id"]
        return {
            "experimentId": input["experiment_id"],
            "trialsSeen": len(trials),
            "failed": sum(1 for t in trials if t.status == "failed"),
        }

    monkeypatch.setattr(_impl, "analyze_experiment", fake_analyze)

    spec = _experiment_spec(candidates=["explore-candidate@1"])

    async with make_worker(
        env, [ExperimentWorkflow, TrialWorkflow, AgentRunWorkflow, EvalWorkflow]
    ):
        result = await env.client.execute_workflow(
            ExperimentWorkflow.run,
            ExperimentInput(spec=spec),
            id="experiment-run_CRASH1",
            task_queue=TASK_QUEUE_CONTROL,
        )

    # The workflow completed despite the crashed child, with the crash
    # isolated to exactly the one (task-b, explore-candidate) cell.
    assert result["trialsSeen"] == 4
    assert result["failed"] == 1

    trials = deps.list_trials(seen["experiment_id"])
    failed = [t for t in trials if t.status == "failed"]
    assert len(failed) == 1, "crashed child must be recorded as exactly one failed TrialRecord"
    assert failed[0].task.name == "task-b"
    assert failed[0].agent_ref == "explore-candidate@1"
    assert "error" in failed[0].evaluation


async def test_artifact_experiment_fans_out_persisted_measurements(env, deps, monkeypatch):
    digest = "sha256:" + "a" * 64
    workload_pin = WorkloadPin(
        source_uri="bundle://python-loop/1.0.0",
        source_kind="bundle",
        collection_revision="test-revision",
        name="python-loop",
        version="1.0.0",
        manifest_digest=digest,
        bundle_digest=digest,
    )
    environment = EnvironmentPin(
        bakudo_version="3.0.0",
        abox_version="1.0.0",
        image_digest=digest,
        profile="python-small",
        hardware_class="test",
        architecture="arm64",
        cpu_count=2,
        memory_mb=512,
        os="linux",
        kernel="6.0",
        dependency_lock_digest=digest,
        environment_digest=digest,
    )

    def revision(value: str) -> dict:
        return RevisionPin(
            repository="example/repository",
            source_uri="https://example.invalid/repository.git",
            commit_sha=value * 40,
            tree_digest=digest,
        ).model_dump(by_alias=True, mode="json")

    baseline_revision = revision("1")
    candidate_revision = revision("2")
    spec = {
        "apiVersion": "bakudo.ai/v1alpha1",
        "kind": "ExperimentSpec",
        "metadata": {"name": "artifact-exp"},
        "subject": {
            "kind": "software-artifact",
            "repository": "example/repository",
            "baseline": baseline_revision,
            "candidates": [candidate_revision],
            "workloadRef": {
                "name": "python-loop",
                "version": "1.0.0",
                "source": "bundle",
            },
        },
        "metrics": {
            "primary": "latency_seconds",
            "directions": {"latency_seconds": "lower"},
        },
        "decision": {"bootstrapResamples": 100},
    }

    def prepare(_spec: dict) -> dict:
        return {
            "status": "completed",
            "workload": workload_pin.ref,
            "workloadSource": "bundle://python-loop/1.0.0",
            "workloadPin": workload_pin.model_dump(by_alias=True, mode="json"),
            "environment": environment.model_dump(by_alias=True, mode="json"),
        }

    def measure(inp, cancel_event=None) -> PerformanceWorkflowResult:
        del cancel_event
        requested_revision = RevisionPin.model_validate(inp.revision)
        summary = 10.0 if requested_revision.commit_sha.startswith("1") else 7.0
        record = MeasurementRecord(
            id=inp.measurement_id,
            workload=workload_pin,
            revision=requested_revision,
            environment=environment,
            plan_digest=digest,
            metrics=(
                MetricSampleSet(
                    metric_name="latency_seconds",
                    unit=MetricUnit.seconds,
                    direction=MetricDirection.lower_is_better,
                    estimator=MetricEstimator.median,
                    samples=(summary,),
                    summary=summary,
                    valid=True,
                ),
            ),
            status=RecordStatus.completed,
            integrity=IntegrityResult(),
        )
        deps.record_measurement(record)
        return PerformanceWorkflowResult(
            operation_id=inp.operation_id,
            kind="measurement",
            status="completed",
            record_id=record.id,
            record=record.to_dict(),
        )

    monkeypatch.setattr(_impl, "prepare_artifact_experiment", prepare)
    monkeypatch.setattr(_impl, "run_performance_measurement", measure)
    monkeypatch.setattr(
        _impl,
        "resolve_experiment_tasks",
        lambda _input: pytest.fail("artifact experiment entered agent task resolution"),
    )

    async with make_worker(env, [ExperimentWorkflow, PerformanceMeasurementWorkflow]):
        result = await env.client.execute_workflow(
            ExperimentWorkflow.run,
            ExperimentInput(spec=spec),
            id="experiment-run_ARTIFACT1",
            task_queue=TASK_QUEUE_CONTROL,
        )

    assert result["subjectKind"] == "software-artifact"
    assert result["comparison"]["candidate-1"]["primary"]["verdict"] == "candidate"
    assert len(result["measurementRecords"]) == 2
    experiment = next(iter(deps._experiments.values()))
    assert experiment["subject_kind"] == "software-artifact"
    assert experiment["status"] == "completed"


# --- CRITICAL fix: dev-mode local_sandbox must run against the provisioned
# fixture, not a fresh empty throwaway repo (abox/local.py workspace_root
# resolution) ---


def test_provision_trial_local_sandbox_uses_provisioned_fixture(monkeypatch):
    """Non-stubbed integration test: real ``provision_trial`` + real
    ``local_sandbox`` for the bundled rate-limiter smoke task, called with the EXACT shape
    ``_impl.run_sandbox`` uses (``bundle`` only, no ``workspace_root``).

    Before the fix, ``local_sandbox`` ignored ``bundle.objective.repo``
    whenever ``workspace_root`` was omitted and always fabricated a fresh,
    empty git repo -- so a Temporal-driven dev-mode trial's tool calls never
    saw the task fixture at all. A custom ``offline_driver`` reads
    ``limiter.py`` through the agent's own ``read-file`` tool and the test
    asserts its content is the REAL fixture content, not a
    file-not-found/empty read against an unrelated throwaway repo.
    """
    monkeypatch.setenv("BAKUDO_ENV", "dev")

    from bakudo.abox.local import local_sandbox
    from bakudo.agent_run_bundle import AgentRunBundle, Budget
    from bakudo.agent_spec import parse_spec
    from bakudo.curriculum.objective import Objective

    provisioned = _impl.provision_trial(
        {"task": "smoke-rate-limiter-fix@1", "agent": "explore", "seed": 1}
    )
    expected_content = (Path(provisioned["repo_path"]) / "limiter.py").read_text()
    assert expected_content, "the provisioned fixture must actually contain limiter.py"

    objective = Objective.model_validate(provisioned["objective"])
    agent_spec = parse_spec(provisioned["agent_spec"])
    bundle = AgentRunBundle(
        run_id="run_localfixture1",
        objective_id=objective.id,
        objective=objective,
        agent_spec=agent_spec,
        budget=Budget(timeoutSeconds=60),
    )

    seen: dict = {}

    def offline_driver(system_prompt, user_prompt, tool_callables):
        seen["content"] = tool_callables["read-file"](path="limiter.py")["content"]
        return json.dumps(
            {
                "status": "success",
                "summary": "read limiter.py",
                "changedFiles": [],
                "proposedFollowups": [],
                "memoriesToWrite": [],
            }
        )

    outcome = local_sandbox(bundle, offline_driver=offline_driver)

    assert seen.get("content") == expected_content, (
        "local_sandbox must run the agent against the provisioned fixture "
        "workspace, not a fresh empty throwaway repo"
    )
    assert outcome.result["status"] == "success"


# --- Finding #4: unpinned arm refs must resolve once, in lockstep with what
# TrialRecord.agent_ref actually records ---


async def test_experiment_workflow_resolves_unpinned_arm_refs(env, deps):
    """An experiment spec with an UNPINNED baseline ref ("explore", no
    ``@version``) must resolve to the actual on-disk version ("explore@1")
    for the trial matrix's agent refs AND for ``analyze_experiment``'s
    spec/the persisted experiment row -- otherwise every (resolved)
    ``TrialRecord.agent_ref`` never equals the (raw, unpinned)
    agent-subject baseline ``assemble_result`` compares against, and every
    per-family/comparison statistic silently zeroes.

    Real (non-stubbed) ``resolve_experiment_tasks`` / ``provision_trial``
    / ``evaluate_trial_verifier`` / ``analyze_experiment`` against the real
    on-disk task source + agents dir; only the ``AgentRunWorkflow`` sandbox is
    stubbed (the ``deps`` fixture) to avoid a live model. Selects the real
    ``rate-limiter-nochange`` task, whose empty ``failToPass`` makes its
    f2p_rate -- and so ``perFamily["no-change"]["baselineMean"]`` -- vacuously
    ``1.0`` regardless of what the stubbed agent's diff actually did, so a
    non-zero result here can only mean the resolved-ref match worked, not
    that the agent happened to "solve" anything.
    """
    spec = {
        "apiVersion": "bakudo.ai/v1alpha1",
        "kind": "ExperimentSpec",
        "metadata": {"name": "unpinned-exp"},
        "subject": {
            "kind": "agent-spec",
            "baseline": "explore",  # deliberately unpinned
            "candidates": [],
            "taskSelector": {"families": ["no-change"], "count": 1},
        },
        "repetitions": 1,
    }

    async with make_worker(
        env, [ExperimentWorkflow, TrialWorkflow, AgentRunWorkflow, EvalWorkflow]
    ):
        result = await env.client.execute_workflow(
            ExperimentWorkflow.run,
            ExperimentInput(spec=spec),
            id="experiment-run_UNPINNED1",
            task_queue=TASK_QUEUE_CONTROL,
        )

    assert result["baseline"] == "explore@1", "result.baseline must carry the resolved ref"
    assert result["candidates"] == []

    experiment = next(iter(deps._experiments.values()))
    assert experiment["spec"]["subject"]["baseline"] == "explore@1", (
        "persisted experiment spec must carry the resolved ref, not the raw unpinned one"
    )

    trials = deps.list_trials(experiment["id"])
    assert trials, "no trials recorded"
    assert all(t.agent_ref == "explore@1" for t in trials), [t.agent_ref for t in trials]

    assert result["perFamily"]["no-change"]["baselineMean"] == 1.0, result["perFamily"]


# --- registration / starters ---


def test_workflows_registered():
    from bakudo.temporal.worker import worker_configs

    configs = {cfg["task_queue"]: cfg for cfg in worker_configs()}
    for queue in (TASK_QUEUE_CONTROL, TASK_QUEUE_RUNS):
        workflows = configs[queue]["workflows"]
        assert TrialWorkflow in workflows, f"TrialWorkflow missing from {queue}"
        assert ExperimentWorkflow in workflows, f"ExperimentWorkflow missing from {queue}"


def test_starters_exist():
    from bakudo.temporal.client import start_experiment, start_trial

    assert callable(start_trial)
    assert callable(start_experiment)


def test_new_activities_registered():
    from bakudo.temporal.activities import (
        analyze_experiment,
        evaluate_trial_verifier,
        persist_experiment,
        persist_trial,
        provision_trial,
        resolve_experiment_tasks,
    )

    for fn in (
        resolve_experiment_tasks,
        provision_trial,
        evaluate_trial_verifier,
        persist_trial,
        persist_experiment,
        analyze_experiment,
    ):
        assert fn in ALL_ACTIVITIES
