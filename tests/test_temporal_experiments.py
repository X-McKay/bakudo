"""TrialWorkflow + ExperimentWorkflow tests (Task 11), mirroring
``tests/test_temporal_workflows.py``'s time-skipping-env / ``Deps``-stubbing
patterns.

Controller ruling R1: ``select_scenarios``/the scenario registry are
filesystem I/O, so they never run in workflow code -- ``resolve_experiment_
scenarios``, ``provision_trial``, ``evaluate_trial_hidden``, and
``analyze_experiment`` are stubbed at the ``_impl`` module-function boundary
here (the same boundary the activity wrappers call through), the same way
``test_temporal_workflows.py`` stubs ``_impl.DEPS.sandbox`` -- these tests
exercise workflow orchestration (fan-out, concurrency, crash handling,
persistence), not the trial/hidden-eval internals Tasks 6/7 already cover.
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
from bakudo.registry import InMemoryLedger
from bakudo.temporal import _impl
from bakudo.temporal.activities import ALL_ACTIVITIES
from bakudo.temporal.shared import (
    TASK_QUEUE_CONTROL,
    TASK_QUEUE_RUNS,
    ExperimentInput,
    TrialInput,
)
from bakudo.temporal.workflows import (
    AgentRunWorkflow,
    EvalWorkflow,
    ExperimentWorkflow,
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


def _objective_doc(scenario_ref: str) -> dict:
    return {
        "id": f"objd_{scenario_ref.replace('@', '_')}",
        "type": "explore",
        "repo": "bakudo",
        "title": f"trial: {scenario_ref}",
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
    spec) without touching the scenario registry/fixture filesystem."""

    agent_spec_doc = _impl.load_agent_spec("explore")
    assert agent_spec_doc is not None

    def _stub(input: dict) -> dict:
        if fail_for is not None and (input["scenario"], input["agent"]) == fail_for:
            raise ApplicationError("provisioning exploded", non_retryable=True)
        name, _, version_s = input["scenario"].partition("@")
        return {
            "repo_path": "/tmp/bakudo-trial-stub",
            "objective": _objective_doc(input["scenario"]),
            "agent_spec": agent_spec_doc,
            "agent_ref": input["agent"],
            "scenario_name": name,
            "scenario_version": int(version_s) if version_s else 1,
            "scenario_digest": f"digest-{name}",
            "budgets": {},
            "network": "none",
            "timeout_seconds": 60,
            "pins": {
                "bakudo": "0.0.0-stub",
                "scenario_digest_algo": "sha256",
                "model_id": agent_spec_doc["model"]["modelId"],
                "sandbox_profile": agent_spec_doc["sandbox"]["profile"],
            },
        }

    return _stub


def _hidden_stub(input: dict) -> dict:
    return {
        "f2p_rate": 1.0,
        "p2p_rate": 1.0,
        "reward": {"fail_to_pass_rate": 1.0, "pass_to_pass_rate": 1.0},
        "detail": "stubbed hidden eval",
        "expected_status": "success",
        "actual_status": input.get("actual_status"),
        "status_match": True,
        "hack_flags": {
            "test_path_violation": False,
            "denied_action_retries": False,
            "scope_violation": False,
            "details": {},
        },
    }


def _scenarios_stub(input: dict) -> dict:
    """Identity arm resolution (every test spec here already uses pinned
    refs) -- ``resolvedArms`` is still built from ``input["spec"]`` so a
    test can also exercise Finding #4's resolution contract by asserting on
    it directly, without special-casing this stub further."""
    spec = input["spec"]
    arm_refs = [spec["baseline"], *spec.get("candidates", [])]
    return {
        "scenarios": [
            {"name": "scenario-a", "version": 1, "digest": "da", "family": "debugging",
             "twin_of": None},
            {"name": "scenario-b", "version": 1, "digest": "db", "family": "debugging",
             "twin_of": None},
        ],
        "resolvedArms": {ref: ref for ref in arm_refs},
    }


@pytest.fixture
def stub_trial_activities(monkeypatch):
    """Stub the filesystem-bound trial activities (provision/hidden-eval),
    leaving persist_trial/persist_experiment real so assertions can read the
    ledger directly."""
    monkeypatch.setattr(_impl, "provision_trial", _provision_stub())
    monkeypatch.setattr(_impl, "evaluate_trial_hidden", _hidden_stub)
    return None


def _experiment_spec(name: str = "exp-test", candidates: list[str] | None = None) -> dict:
    return {
        "apiVersion": "bakudo.ai/v1alpha1",
        "kind": "ExperimentSpec",
        "metadata": {"name": name},
        "subject": "agent-spec",
        "baseline": "explore@1",
        "candidates": candidates if candidates is not None else ["explore@1"],
        "scenarioSelector": {"count": 20},
        "repetitions": 1,
    }


# --- TrialWorkflow ---


async def test_trial_workflow_happy_path(env, deps, monkeypatch):
    calls = {"provision": 0, "hidden": 0}

    provision_impl = _provision_stub()

    def counted_provision(input: dict) -> dict:
        calls["provision"] += 1
        return provision_impl(input)

    def counted_hidden(input: dict) -> dict:
        calls["hidden"] += 1
        return _hidden_stub(input)

    monkeypatch.setattr(_impl, "provision_trial", counted_provision)
    monkeypatch.setattr(_impl, "evaluate_trial_hidden", counted_hidden)

    async with make_worker(env, [TrialWorkflow, AgentRunWorkflow, EvalWorkflow]):
        out = await env.client.execute_workflow(
            TrialWorkflow.run,
            TrialInput(scenario="scenario-a@1", agent="explore@1", seed=7),
            id="trial-run_HAPPY1",
            task_queue=TASK_QUEUE_CONTROL,
        )

    assert calls == {"provision": 1, "hidden": 1}
    assert out["status"] == "completed"
    assert out["agent_ref"] == "explore@1"
    assert out["scenario_name"] == "scenario-a"
    assert out["evaluation"]["f2p_rate"] == 1.0
    assert out["seed"] == 7

    # Finding #2: pins must carry the same provenance fields the sync
    # run_trial path records, not be dropped to {}.
    assert out["pins"], "pins must not be empty on the Temporal trial path"
    assert out["pins"]["bakudo"] == "0.0.0-stub"
    assert out["pins"]["scenario_digest_algo"] == "sha256"
    assert out["pins"]["model_id"]
    assert out["pins"]["sandbox_profile"]

    # Finding #3: the AgentRunWorkflow child's scorecard must not be
    # silently dropped from evaluation.
    assert out["evaluation"]["scorecard"] is not None

    recorded = deps.get_trial(out["id"])
    assert recorded is not None
    assert recorded.status == "completed"
    assert recorded.agent_ref == "explore@1"
    assert recorded.pins == out["pins"]
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
        runtime_seconds=12.5,
    )


async def test_trial_workflow_normalizes_temporal_metrics_keys(env, monkeypatch):
    ledger = InMemoryLedger()
    monkeypatch.setattr(_impl.DEPS, "ledger", ledger)
    monkeypatch.setattr(_impl.DEPS, "sandbox", stub_sandbox_with_raw_metrics)
    monkeypatch.setattr(_impl, "provision_trial", _provision_stub())
    monkeypatch.setattr(_impl, "evaluate_trial_hidden", _hidden_stub)

    async with make_worker(env, [TrialWorkflow, AgentRunWorkflow, EvalWorkflow]):
        out = await env.client.execute_workflow(
            TrialWorkflow.run,
            TrialInput(scenario="scenario-a@1", agent="explore@1", seed=11),
            id="trial-run_METRICS1",
            task_queue=TASK_QUEUE_CONTROL,
        )

    assert out["metrics"]["tokens"] == 4321.0, out["metrics"]
    assert out["metrics"]["tool_calls"] == 6.0, out["metrics"]
    assert out["metrics"]["duration_s"] == 12.5, out["metrics"]

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

    monkeypatch.setattr(_impl, "resolve_experiment_scenarios", _scenarios_stub)
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

    # 2 scenarios x 1 repetition x 2 arms (baseline + 1 candidate) -> 4 trials.
    assert analyzed["trial_count"] == 4
    assert result["trialsSeen"] == 4

    experiment = deps.get_experiment(analyzed["experiment_id"])
    assert experiment is not None
    assert experiment["status"] == "completed"
    assert experiment["result"] == result


async def test_experiment_child_crash_recorded(env, deps, monkeypatch):
    # One (scenario, agent) cell -- the candidate arm on scenario-b -- fails
    # to provision; every other cell succeeds. Distinct baseline/candidate
    # refs (the stub doesn't care that "explore-candidate@1" isn't a real
    # on-disk spec -- it never loads one) isolate exactly one of the 4
    # planned trials to crash.
    monkeypatch.setattr(
        _impl,
        "provision_trial",
        _provision_stub(fail_for=("scenario-b@1", "explore-candidate@1")),
    )
    monkeypatch.setattr(_impl, "evaluate_trial_hidden", _hidden_stub)
    monkeypatch.setattr(_impl, "resolve_experiment_scenarios", _scenarios_stub)

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
    # isolated to exactly the one (scenario-b, explore-candidate) cell.
    assert result["trialsSeen"] == 4
    assert result["failed"] == 1

    trials = deps.list_trials(seen["experiment_id"])
    failed = [t for t in trials if t.status == "failed"]
    assert len(failed) == 1, "crashed child must be recorded as exactly one failed TrialRecord"
    assert failed[0].scenario_name == "scenario-b"
    assert failed[0].agent_ref == "explore-candidate@1"
    assert "error" in failed[0].evaluation


# --- CRITICAL fix: dev-mode local_sandbox must run against the provisioned
# fixture, not a fresh empty throwaway repo (abox/local.py workspace_root
# resolution) ---


def test_provision_trial_local_sandbox_uses_provisioned_fixture(monkeypatch):
    """Non-stubbed integration test: real ``provision_trial`` + real
    ``local_sandbox`` for csv-sum-offbyone, called with the EXACT shape
    ``_impl.run_sandbox`` uses (``bundle`` only, no ``workspace_root``).

    Before the fix, ``local_sandbox`` ignored ``bundle.objective.repo``
    whenever ``workspace_root`` was omitted and always fabricated a fresh,
    empty git repo -- so a Temporal-driven dev-mode trial's tool calls never
    saw the scenario fixture at all. A custom ``offline_driver`` reads
    ``summer.py`` through the agent's own ``read-file`` tool and the test
    asserts its content is the REAL fixture content, not a
    file-not-found/empty read against an unrelated throwaway repo.
    """
    monkeypatch.setenv("BAKUDO_ENV", "dev")

    from bakudo.abox.local import local_sandbox
    from bakudo.agent_spec import parse_spec
    from bakudo.bundle import Budget, TaskBundle
    from bakudo.curriculum.objective import Objective

    provisioned = _impl.provision_trial(
        {"scenario": "csv-sum-offbyone@1", "agent": "explore", "seed": 1}
    )
    expected_content = (Path(provisioned["repo_path"]) / "summer.py").read_text()
    assert expected_content, "the provisioned fixture must actually contain summer.py"

    objective = Objective.model_validate(provisioned["objective"])
    agent_spec = parse_spec(provisioned["agent_spec"])
    bundle = TaskBundle(
        run_id="run_localfixture1",
        objective_id=objective.id,
        objective=objective,
        agent_spec=agent_spec,
        budget=Budget(timeoutSeconds=60),
    )

    seen: dict = {}

    def offline_driver(system_prompt, user_prompt, tool_callables):
        seen["content"] = tool_callables["read-file"](path="summer.py")["content"]
        return json.dumps(
            {
                "status": "success",
                "summary": "read summer.py",
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
    ``spec.baseline`` ``assemble_result`` compares against, and every
    per-family/comparison statistic silently zeroes.

    Real (non-stubbed) ``resolve_experiment_scenarios`` / ``provision_trial``
    / ``evaluate_trial_hidden`` / ``analyze_experiment`` against the real
    on-disk registry + agents dir; only the ``AgentRunWorkflow`` sandbox is
    stubbed (the ``deps`` fixture) to avoid a live model. Selects the real
    ``rate-limiter-nochange`` scenario, whose empty ``failToPass`` makes its
    f2p_rate -- and so ``perFamily["no-change"]["baselineMean"]`` -- vacuously
    ``1.0`` regardless of what the stubbed agent's diff actually did, so a
    non-zero result here can only mean the resolved-ref match worked, not
    that the agent happened to "solve" anything.
    """
    spec = {
        "apiVersion": "bakudo.ai/v1alpha1",
        "kind": "ExperimentSpec",
        "metadata": {"name": "unpinned-exp"},
        "subject": "agent-spec",
        "baseline": "explore",  # deliberately unpinned
        "candidates": [],
        "scenarioSelector": {"families": ["no-change"], "count": 1},
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
    assert experiment["spec"]["baseline"] == "explore@1", (
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
        evaluate_trial_hidden,
        persist_experiment,
        persist_trial,
        provision_trial,
        resolve_experiment_scenarios,
    )

    for fn in (
        resolve_experiment_scenarios,
        provision_trial,
        evaluate_trial_hidden,
        persist_trial,
        persist_experiment,
        analyze_experiment,
    ):
        assert fn in ALL_ACTIVITIES
