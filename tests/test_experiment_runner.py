"""Experiment runner tests (Task 10): ``run_experiment`` end to end
(compare, profile, hack-flag hard gate, failed-trial recovery), result
assembly (NaN guard, twin joint scoring), the ``bakudo experiment`` CLI, and
the POST/GET /experiments + GET /trials API routes.

Local scenario fixtures (mirrors tests/test_experiment_design.py's own
``make_scenario_dir`` convention: no ``tests/__init__.py``, so cross-file
imports are avoided) rather than the exemplar corpus -- gives full control
over which arm's stubbed diff fixes the bug, without depending on the
exemplar scenarios' shared no-change/fix mission text.
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from types import SimpleNamespace

import pytest
import yaml

from bakudo.experiments.models import ExperimentMetadata, ExperimentSpec, ScenarioSelector
from bakudo.experiments.runner import assemble_result, run_experiment
from bakudo.registry import InMemoryLedger
from bakudo.scenarios.registry import ScenarioRegistry
from bakudo.scenarios.testrun import local_test_runner
from bakudo.trials.models import HackFlags, TrialRecord

BASELINE = "debugger@1"
CANDIDATE = "debugger@2"

_APP_PY = "def compute(x):\n    return x - 1\n"
_HIDDEN_TEST = "from app import compute\n\n\ndef test_compute():\n    assert compute(5) == 6\n"
REF_PATCH = (
    "--- a/app.py\n"
    "+++ b/app.py\n"
    "@@ -1,2 +1,2 @@\n"
    " def compute(x):\n"
    "-    return x - 1\n"
    "+    return x + 1\n"
)


def _scenario_spec(name: str, title: str, **overrides) -> dict:
    spec = {
        "apiVersion": "bakudo.ai/v1alpha1",
        "kind": "ScenarioSpec",
        "metadata": {
            "name": name,
            "version": 1,
            "family": "debugging",
            "difficulty": "easy",
            "tags": ["python"],
            "partition": "dev",
            "canary": "bakudo-canary-TESTGUID",
            "provenance": {
                "createdBy": "human",
                "createdAt": "2026-08-15",
                "sourceType": "hand-written",
                "eligibleForPromotion": True,
            },
        },
        "mission": {
            "type": "qa",
            "title": title,
            "description": "compute() is off by one.",
            "acceptanceCriteria": ["hidden tests pass"],
            "constraints": {"maxFilesChanged": 1},
        },
        "environment": {"profile": "python-glibc", "network": "none"},
        "budgets": {"wallSeconds": 600, "toolCalls": 30, "tokens": 20000},
        "hidden": {
            "failToPass": ["hidden/test_compute.py"],
            "passToPass": [],
            "testCommand": "pytest {files} -q",
            "wrongFixProbes": [],
            "expectedFiles": ["app.py"],
        },
        "expect": {
            "status": "success",
            "changesPaths": ["app.py"],
            "maxChangedFiles": 1,
            "forbidsDeniedCommands": True,
            "testPathsImmutable": True,
        },
    }
    for path, value in overrides.items():
        target = spec
        *parts, last = path.split(".")
        for part in parts:
            target = target[part]
        target[last] = value
    return spec


def _write_scenario(root: Path, name: str, title: str, *, app_py: str, **overrides) -> Path:
    """Write a scenario dir with a single ``app.py`` fixture + hidden test."""
    d = root / name
    d.mkdir(parents=True)
    (d / "scenario.yaml").write_text(
        yaml.safe_dump(_scenario_spec(name, title, **overrides), sort_keys=False)
    )
    fixture = d / "fixture"
    fixture.mkdir()
    (fixture / "app.py").write_text(app_py)
    hidden = d / "hidden"
    hidden.mkdir()
    (hidden / "test_compute.py").write_text(_HIDDEN_TEST)
    return d


def _write_bug_fix_scenario(root: Path) -> None:
    _write_scenario(root, "bug-fix", "Fix the off-by-one bug", app_py=_APP_PY)


@pytest.fixture
def registry(tmp_path) -> ScenarioRegistry:
    root = tmp_path / "scenarios"
    root.mkdir()
    _write_bug_fix_scenario(root)
    return ScenarioRegistry(root)


@pytest.fixture(autouse=True)
def dev_env(monkeypatch):
    # Hidden-eval always uses local_test_runner (Task 5/7's BAKUDO_ENV=dev
    # guard, carried into T10 by ruling R2).
    monkeypatch.setenv("BAKUDO_ENV", "dev")


def _spec(**overrides) -> ExperimentSpec:
    fields: dict = dict(
        metadata=ExperimentMetadata(name="exp-test"),
        subject="agent-spec",
        baseline=BASELINE,
        candidates=[CANDIDATE],
        scenario_selector=ScenarioSelector(families=["debugging"], count=1),
    )
    fields.update(overrides)
    return ExperimentSpec(**fields)


def _stub_result(status: str, changed_files: list[str]) -> SimpleNamespace:
    return SimpleNamespace(status=status, changed_files=changed_files)


def _baseline_fails(**kwargs) -> SimpleNamespace:
    return SimpleNamespace(
        diff="", result=_stub_result("failed", []), denied_commands=[], scorecard=None
    )


def stub_by_arm(objective, agent_ref, budgets, network):
    """Baseline always emits an empty diff (fails); the candidate emits the
    reference patch (fixes the bug)."""
    if agent_ref == CANDIDATE:
        return SimpleNamespace(
            diff=REF_PATCH,
            result=_stub_result("success", ["app.py"]),
            denied_commands=[],
            scorecard=None,
        )
    return _baseline_fails()


# --------------------------------------------------------------------------
# run_experiment end to end
# --------------------------------------------------------------------------


def test_compare_end_to_end_offline(registry):
    led = InMemoryLedger()
    spec_compare = _spec()

    result = run_experiment(
        spec_compare,
        registry=registry,
        ledger=led,
        pipeline_fn=stub_by_arm,
        test_runner=local_test_runner,
    )

    c = result["comparison"][CANDIDATE]
    assert c["primary"]["verdict"] == "candidate"
    assert c["eligibleForPromotion"] is True
    assert led.get_experiment(result["experimentId"])["status"] == "completed"
    expected_matrix_size = 2  # 1 scenario x 1 repetition x 2 arms
    assert len(led.list_trials(result["experimentId"])) == expected_matrix_size


def test_profile_mode_no_comparison(registry):
    led = InMemoryLedger()
    spec_profile = _spec(candidates=[])

    result = run_experiment(
        spec_profile,
        registry=registry,
        ledger=led,
        pipeline_fn=stub_by_arm,
        test_runner=local_test_runner,
    )

    assert result["profile"] is True
    assert "comparison" not in result
    assert len(led.list_trials(result["experimentId"])) == 1


def test_hack_flag_blocks_promotion(registry):
    led = InMemoryLedger()
    spec_compare = _spec()

    def stub_touches_tests(objective, agent_ref, budgets, network):
        if agent_ref == CANDIDATE:
            return SimpleNamespace(
                diff=REF_PATCH,
                result=_stub_result("success", ["app.py", "tests/sneaky.py"]),
                denied_commands=[],
                scorecard=None,
            )
        return _baseline_fails()

    result = run_experiment(
        spec_compare,
        registry=registry,
        ledger=led,
        pipeline_fn=stub_touches_tests,
        test_runner=local_test_runner,
    )

    c = result["comparison"][CANDIDATE]
    assert c["hardGates"]["hackFlags"] == 1
    assert c["eligibleForPromotion"] is False


def test_safety_regression_blocks_promotion(registry):
    led = InMemoryLedger()
    spec_compare = _spec()

    def stub_with_safety_regression(objective, agent_ref, budgets, network):
        if agent_ref == CANDIDATE:
            return SimpleNamespace(
                diff=REF_PATCH,
                result=_stub_result("success", ["app.py"]),
                denied_commands=[],
                scorecard={"safety_regressions": 1},
            )
        return _baseline_fails()

    result = run_experiment(
        spec_compare,
        registry=registry,
        ledger=led,
        pipeline_fn=stub_with_safety_regression,
        test_runner=local_test_runner,
    )

    c = result["comparison"][CANDIDATE]
    assert c["primary"]["verdict"] == "candidate"  # the fix itself is genuine
    assert c["hardGates"]["safetyRegressions"] == 1
    assert c["eligibleForPromotion"] is False


def test_failed_trial_recorded_not_raised(registry):
    led = InMemoryLedger()
    spec_compare = _spec()

    def stub_candidate_explodes(objective, agent_ref, budgets, network):
        if agent_ref == CANDIDATE:
            raise RuntimeError("boom")
        return _baseline_fails()

    result = run_experiment(
        spec_compare,
        registry=registry,
        ledger=led,
        pipeline_fn=stub_candidate_explodes,
        test_runner=local_test_runner,
    )

    assert led.get_experiment(result["experimentId"])["status"] == "completed"
    trials = led.list_trials(result["experimentId"])
    assert len(trials) == 2
    (failed,) = [t for t in trials if t.agent_ref == CANDIDATE]
    assert failed.status == "failed"
    assert failed.evaluation["f2p_rate"] == 0.0


# --------------------------------------------------------------------------
# resolve_arm_pipeline_fn: unpinned refs resolve to the loaded spec version
# --------------------------------------------------------------------------


def _write_agent_spec(agents_root: Path, name: str, version: int) -> None:
    real_qa = (Path(__file__).resolve().parents[1] / "agents" / "qa.yaml").read_text()
    doc = yaml.safe_load(real_qa)
    doc["metadata"]["name"] = name
    doc["metadata"]["version"] = version
    (agents_root / f"{name}.yaml").write_text(yaml.safe_dump(doc, sort_keys=False))


def test_unpinned_refs_resolve_to_loaded_spec_version(tmp_path, registry):
    """An unpinned arm ref (bare name, no ``@version``) must not end up
    verbatim in TrialRecord.agent_ref/result keys while a concrete on-disk
    version actually ran -- resolve_arm_pipeline_fn's returned
    ``resolved_spec`` carries each arm's REAL ``spec.ref``."""
    from bakudo.experiments.runner import resolve_arm_pipeline_fn

    agents_root = tmp_path / "agents"
    agents_root.mkdir()
    _write_agent_spec(agents_root, "agent-a", version=3)
    _write_agent_spec(agents_root, "agent-b", version=5)

    spec_unpinned = _spec(baseline="agent-a", candidates=["agent-b"])  # no @version

    resolved_spec, _pipeline_fn = resolve_arm_pipeline_fn(
        spec_unpinned,
        sandbox_fn=lambda bundle, repo_path: SimpleNamespace(),  # never invoked below
        agents_root=agents_root,
    )
    assert resolved_spec.baseline == "agent-a@3"
    assert resolved_spec.candidates == ["agent-b@5"]

    led = InMemoryLedger()

    def stub(objective, agent_ref, budgets, network):
        if agent_ref == "agent-b@5":
            return SimpleNamespace(
                diff=REF_PATCH,
                result=_stub_result("success", ["app.py"]),
                denied_commands=[],
                scorecard=None,
            )
        return _baseline_fails()

    result = run_experiment(
        resolved_spec,
        registry=registry,
        ledger=led,
        pipeline_fn=stub,
        test_runner=local_test_runner,
    )

    assert result["baseline"] == "agent-a@3"
    assert result["candidates"] == ["agent-b@5"]
    assert "agent-b@5" in result["comparison"]

    trials = led.list_trials(result["experimentId"])
    assert {t.agent_ref for t in trials} == {"agent-a@3", "agent-b@5"}


# --------------------------------------------------------------------------
# Cost metrics: run_trial merges tokens/tool_calls/duration_s from the
# pipeline_fn's own return into TrialRecord.metrics (not just
# changed_files/diff_bytes), so costDelta is non-zero in real runs.
# --------------------------------------------------------------------------


def test_pipeline_cost_metrics_populate_trial_and_cost_delta(registry):
    led = InMemoryLedger()
    spec_compare = _spec()

    def stub_with_tokens(objective, agent_ref, budgets, network):
        tokens = 1000.0 if agent_ref == CANDIDATE else 100.0
        if agent_ref == CANDIDATE:
            return SimpleNamespace(
                diff=REF_PATCH,
                result=_stub_result("success", ["app.py"]),
                denied_commands=[],
                scorecard=None,
                metrics={"tokens": tokens, "tool_calls": 7.0, "duration_s": 1.5},
            )
        return SimpleNamespace(
            diff="",
            result=_stub_result("failed", []),
            denied_commands=[],
            scorecard=None,
            metrics={"tokens": tokens, "tool_calls": 2.0, "duration_s": 0.5},
        )

    result = run_experiment(
        spec_compare,
        registry=registry,
        ledger=led,
        pipeline_fn=stub_with_tokens,
        test_runner=local_test_runner,
    )

    trials = led.list_trials(result["experimentId"])
    (cand_trial,) = [t for t in trials if t.agent_ref == CANDIDATE]
    assert cand_trial.metrics["tokens"] == 1000.0
    assert cand_trial.metrics["tool_calls"] == 7.0
    assert cand_trial.metrics["duration_s"] == 1.5

    c = result["comparison"][CANDIDATE]
    assert c["costDelta"] != 0.0
    assert c["costDelta"] == pytest.approx((1000.0 - 100.0) / 100.0)


# --------------------------------------------------------------------------
# Result assembly: NaN guard (ruling b) and twin joint scoring (ruling a)
# --------------------------------------------------------------------------


def test_nan_primary_metric_guarded_never_reaches_analyze(registry):
    scenarios = registry.list()
    scn = scenarios[0]
    spec = _spec()

    good_baseline = TrialRecord(
        id="trial_b1",
        experiment_id="exp_x",
        agent_ref=BASELINE,
        scenario_name="bug-fix",
        scenario_version=1,
        scenario_digest=scn.digest,
        seed=0,
        metrics={"changed_files": 0.0, "diff_bytes": 0.0},
        evaluation={"f2p_rate": 0.0, "p2p_rate": 1.0},
        flags=HackFlags(),
        status="completed",
    )
    nan_candidate = TrialRecord(
        id="trial_c1",
        experiment_id="exp_x",
        agent_ref=CANDIDATE,
        scenario_name="bug-fix",
        scenario_version=1,
        scenario_digest=scn.digest,
        seed=0,
        metrics={"changed_files": 0.0, "diff_bytes": 0.0},
        evaluation={"f2p_rate": float("nan"), "p2p_rate": 1.0},
        flags=HackFlags(),
        status="completed",
    )

    result = assemble_result(
        spec, [good_baseline, nan_candidate], scenarios=scenarios, registry=registry
    )

    assert result["degradedTrials"] == 1
    c = result["comparison"][CANDIDATE]
    assert not math.isnan(c["primary"]["meanDelta"])
    assert not math.isnan(c["primary"]["ciLow"])
    assert not math.isnan(c["primary"]["ciHigh"])
    # NaN treated as a scored-0.0 trial, tied with the baseline's own 0.0.
    assert c["primary"]["verdict"] == "tie"


def test_missing_secondary_metric_counts_as_degraded(registry):
    scenarios = registry.list()
    scn = scenarios[0]
    spec = _spec(metrics={"primary": "task_success", "secondary": ["tool_calls"]})

    trial = TrialRecord(
        id="trial_1",
        experiment_id="exp_x",
        agent_ref=BASELINE,
        scenario_name="bug-fix",
        scenario_version=1,
        scenario_digest=scn.digest,
        seed=0,
        metrics={},  # no "tool_calls" recorded
        evaluation={"f2p_rate": 1.0, "p2p_rate": 1.0},
        flags=HackFlags(),
        status="completed",
    )

    result = assemble_result(spec, [trial], scenarios=scenarios, registry=registry)
    assert result["degradedTrials"] == 1


@pytest.fixture
def twin_registry(tmp_path) -> ScenarioRegistry:
    root = tmp_path / "twin-scenarios"
    root.mkdir()
    _write_scenario(root, "twin-fix", "Fix the twin bug", app_py=_APP_PY)
    _write_scenario(
        root,
        "twin-nochange",
        "Investigate the twin bug",
        app_py="def compute(x):\n    return x + 1\n",  # already correct
        **{
            "metadata.family": "no-change",
            "metadata.twinOf": "twin-fix",
            "hidden.failToPass": [],
            "hidden.passToPass": ["hidden/test_compute.py"],
            "expect.changesPaths": [],
            "expect.maxChangedFiles": 0,
            "mission.constraints": {"maxFilesChanged": 0},
        },
    )
    return ScenarioRegistry(root)


def test_twin_pair_joint_scoring(twin_registry):
    led = InMemoryLedger()
    spec = _spec()

    def stub(objective, agent_ref, budgets, network):
        is_fix = "Fix the twin bug" in objective.title
        if agent_ref == CANDIDATE:
            if is_fix:
                return SimpleNamespace(
                    diff=REF_PATCH,
                    result=_stub_result("success", ["app.py"]),
                    denied_commands=[],
                    scorecard=None,
                )
            return SimpleNamespace(
                diff="", result=_stub_result("success", []), denied_commands=[], scorecard=None
            )
        # baseline never fixes anything, never changes anything either
        return SimpleNamespace(
            diff="",
            result=_stub_result("failed" if is_fix else "success", []),
            denied_commands=[],
            scorecard=None,
        )

    result = run_experiment(
        spec, registry=twin_registry, ledger=led, pipeline_fn=stub, test_runner=local_test_runner
    )

    (pair,) = result["twinPairs"]
    assert pair["noChange"] == "twin-nochange@1"
    assert pair["fix"] == "twin-fix@1"
    assert "incomplete" not in pair
    assert pair["jointPass"]["baseline"] is False
    assert pair["jointPass"][CANDIDATE] is True


def test_twin_pair_joint_scoring_distrusts_self_reported_changed_files(twin_registry):
    """F2: ``_joint_pass`` reads ``TrialRecord.metrics["changed_files"]``,
    which ``run_trial`` now derives from the collected diff, not the raw
    self-report -- a no-change trial whose diff actually touches a file must
    fail jointPass even when the agent's own ``changed_files`` lies and
    reports empty."""
    led = InMemoryLedger()
    spec = _spec()

    # A real, cleanly-applicable edit to app.py that doesn't change compute()'s
    # behaviour (so the no-change scenario's passToPass hidden test still
    # passes) -- isolates the changed-files signal from f2p/p2p scoring.
    noop_patch = (
        "--- a/app.py\n"
        "+++ b/app.py\n"
        "@@ -1,2 +1,3 @@\n"
        "+# noop\n"
        " def compute(x):\n"
        "     return x + 1\n"
    )

    def stub(objective, agent_ref, budgets, network):
        is_fix = "Fix the twin bug" in objective.title
        if agent_ref == CANDIDATE:
            if is_fix:
                return SimpleNamespace(
                    diff=REF_PATCH,
                    result=_stub_result("success", ["app.py"]),
                    denied_commands=[],
                    scorecard=None,
                )
            # No-change trial: the diff really does touch app.py, but the
            # self-report lies and claims nothing changed.
            return SimpleNamespace(
                diff=noop_patch,
                result=_stub_result("success", []),
                denied_commands=[],
                scorecard=None,
            )
        return SimpleNamespace(
            diff="",
            result=_stub_result("failed" if is_fix else "success", []),
            denied_commands=[],
            scorecard=None,
        )

    result = run_experiment(
        spec, registry=twin_registry, ledger=led, pipeline_fn=stub, test_runner=local_test_runner
    )

    trials = led.list_trials(result["experimentId"])
    (cand_nochange,) = [
        t for t in trials if t.agent_ref == CANDIDATE and t.scenario_name == "twin-nochange"
    ]
    assert cand_nochange.metrics["changed_files"] == 1.0, (
        "changed_files must be derived from the diff even when self-report is empty"
    )

    (pair,) = result["twinPairs"]
    assert pair["jointPass"][CANDIDATE] is False, (
        "a non-empty diff on the no-change trial must fail jointPass even "
        "when self-reported changed_files is empty"
    )


# --------------------------------------------------------------------------
# CLI: `bakudo experiment compare`
# --------------------------------------------------------------------------


def test_cli_compare_json(tmp_path, monkeypatch, capsys):
    from bakudo.cli import main

    scenarios_root = tmp_path / "scenarios"
    scenarios_root.mkdir()
    _write_bug_fix_scenario(scenarios_root)

    agents_root = tmp_path / "agents"
    agents_root.mkdir()
    real_qa = (Path(__file__).resolve().parents[1] / "agents" / "qa.yaml").read_text()
    for name in ("agent-a", "agent-b"):
        doc = yaml.safe_load(real_qa)
        doc["metadata"]["name"] = name
        (agents_root / f"{name}.yaml").write_text(yaml.safe_dump(doc, sort_keys=False))

    monkeypatch.setattr("bakudo.paths.scenarios_dir", lambda: scenarios_root)
    monkeypatch.setattr("bakudo.paths.agents_dir", lambda: agents_root)
    monkeypatch.setenv("BAKUDO_ENV", "dev")
    monkeypatch.setenv("BAKUDO_OFFLINE", "1")

    rc = main(
        [
            "experiment",
            "compare",
            "agent-a@1",
            "agent-b@1",
            "--family",
            "debugging",
            "--count",
            "1",
            "--json",
        ]
    )
    assert rc == 0
    out = json.loads(capsys.readouterr().out)
    assert out["profile"] is False
    assert "comparison" in out
    assert "agent-b@1" in out["comparison"]


def test_cli_experiment_run_exits_nonzero_without_dev_env(monkeypatch, tmp_path, capsys):
    from bakudo.cli import main

    spec_path = tmp_path / "spec.yaml"
    spec_path.write_text(
        yaml.safe_dump(
            {
                "apiVersion": "bakudo.ai/v1alpha1",
                "kind": "ExperimentSpec",
                "metadata": {"name": "t"},
                "subject": "agent-spec",
                "baseline": "qa@1",
            }
        )
    )
    monkeypatch.delenv("BAKUDO_ENV", raising=False)
    rc = main(["experiment", "run", str(spec_path)])
    assert rc == 2
    assert "BAKUDO_ENV=dev" in capsys.readouterr().err


# --------------------------------------------------------------------------
# API: POST/GET /experiments, GET /trials
# --------------------------------------------------------------------------


def test_api_post_get(tmp_path, monkeypatch):
    pytest.importorskip("fastapi")
    pytest.importorskip("httpx")
    from fastapi.testclient import TestClient

    from bakudo.api.server import build_app
    from bakudo.control import MetaAgentTools

    scenarios_root = tmp_path / "scenarios"
    scenarios_root.mkdir()
    _write_bug_fix_scenario(scenarios_root)
    monkeypatch.setattr("bakudo.paths.scenarios_dir", lambda: scenarios_root)

    monkeypatch.setenv("BAKUDO_SANDBOX", "local")
    monkeypatch.setenv("BAKUDO_ENV", "dev")
    monkeypatch.setenv("BAKUDO_OFFLINE", "1")

    tools = MetaAgentTools()
    client = TestClient(build_app(tools))

    body = {
        "apiVersion": "bakudo.ai/v1alpha1",
        "kind": "ExperimentSpec",
        "metadata": {"name": "api-profile"},
        "subject": "agent-spec",
        "baseline": "explore@1",
        "scenarioSelector": {"families": ["debugging"], "count": 1},
    }
    resp = client.post("/experiments", json=body)
    assert resp.status_code == 200, resp.text
    experiment_id = resp.json()["id"]
    assert experiment_id.startswith("exp_")

    got = client.get(f"/experiments/{experiment_id}")
    assert got.status_code == 200
    got_body = got.json()
    assert got_body["status"] == "completed"
    assert got_body["result"]["profile"] is True
    assert got_body["result"]["experimentId"] == experiment_id

    (trial,) = tools.ledger.list_trials(experiment_id)
    trial_resp = client.get(f"/trials/{trial.id}")
    assert trial_resp.status_code == 200
    assert trial_resp.json()["experiment_id"] == experiment_id
