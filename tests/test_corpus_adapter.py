"""Task 7: the scenario-backed corpus adapter.

``load_corpus_from_scenarios`` maps the scenario registry onto the legacy
``EvalCase``/``run_corpus`` shape, and ``scenario_run_fn`` bridges a
``run_corpus``-style ``run_fn(objective) -> CaseRun`` to the trial substrate
(``bakudo.trials.runner.run_trial``). ``run_corpus`` itself is untouched --
these tests only prove the new adapter feeds it correctly.
"""

from __future__ import annotations

import pytest

from bakudo.curriculum.objective import Objective
from bakudo.evals.corpus import (
    CaseRun,
    load_corpus,
    load_corpus_from_scenarios,
    run_corpus,
    scenario_run_fn,
)
from bakudo.paths import scenarios_dir
from bakudo.runner.result import RunResult
from bakudo.scenarios.registry import ScenarioRegistry
from bakudo.scenarios.testrun import TestRunResult
from bakudo.trials.runner import _StubPipelineResult


@pytest.fixture
def registry() -> ScenarioRegistry:
    return ScenarioRegistry(scenarios_dir())


def _always_passing_test_runner(workspace, command):
    return TestRunResult(passed=True, exit_code=0, output="")


# --------------------------------------------------------------------------
# load_corpus_from_scenarios
# --------------------------------------------------------------------------


def test_maps_a_real_exemplar_to_a_valid_eval_case(registry):
    cases = load_corpus_from_scenarios(families=["debugging"], registry=registry)
    assert cases
    names = {c.name for c in cases}
    assert "csv-sum-offbyone@1" in names

    scenario = registry.get("csv-sum-offbyone@1")
    case = next(c for c in cases if c.name == "csv-sum-offbyone@1")

    assert case.objective.type.value == scenario.spec.mission.type
    assert case.objective.title == scenario.spec.mission.title
    assert case.objective.acceptance_criteria == scenario.spec.mission.acceptance_criteria
    case.objective.validate_against_schema()

    assert case.expect.status == scenario.spec.expect.status
    assert case.expect.changes_paths == scenario.spec.expect.changes_paths
    assert case.expect.max_changed_files == scenario.spec.expect.max_changed_files
    assert case.expect.forbids_denied_commands == scenario.spec.expect.forbids_denied_commands


def test_family_and_partition_filters_are_honored(registry):
    debugging_only = load_corpus_from_scenarios(families=["debugging"], registry=registry)
    assert debugging_only
    assert all(
        registry.get(c.name).spec.metadata.family.value == "debugging" for c in debugging_only
    )

    two_families = load_corpus_from_scenarios(
        families=["debugging", "no-change"], registry=registry
    )
    assert len(two_families) > len(debugging_only)

    everything = load_corpus_from_scenarios(registry=registry)
    assert len(everything) >= len(two_families)

    # Every exemplar ships in the "dev" partition, so a partition that
    # excludes it must come back empty rather than erroring.
    holdout_only = load_corpus_from_scenarios(partitions=("holdout",), registry=registry)
    assert holdout_only == []


def test_case_names_are_unique_scenario_refs(registry):
    cases = load_corpus_from_scenarios(registry=registry)
    names = [c.name for c in cases]
    assert len(names) == len(set(names))
    assert all("@" in n for n in names)


# --------------------------------------------------------------------------
# run_corpus over scenario-backed cases (shape parity with the legacy path)
# --------------------------------------------------------------------------


def _stub_pipeline_factory(*, changed_files=(), diff="", denied=(), metrics=None):
    def build():
        def pipeline_fn(objective, agent_ref, budgets, network):
            return _StubPipelineResult(
                diff=diff,
                result=RunResult(
                    run_id="run_stub",
                    agent=agent_ref,
                    objective_id=objective.id,
                    status="success",
                    summary="stub run",
                    changed_files=list(changed_files),
                ),
                denied_commands=list(denied),
                metrics=metrics or {},
            )

        return pipeline_fn

    return build


def test_run_corpus_over_scenario_backed_cases_matches_legacy_shape(registry):
    cases = load_corpus_from_scenarios(families=["debugging"], registry=registry)[:2]
    run_fn = scenario_run_fn(
        test_runner=_always_passing_test_runner,
        pipeline_factory=_stub_pipeline_factory(),
    )

    results = run_corpus("debugging-smoke", cases, run_fn, subject_id="debugger@1")
    by_suite = {r.suite_name: r for r in results}

    # Same synthetic suites, same aggregation math as the legacy YAML path
    # (tests/test_corpus.py pins this shape) -- only the case *source*
    # changed.
    assert "role-specific" in by_suite
    assert "regression" in by_suite
    assert all(r.details["cases_total"] == 2 for r in results)
    assert all(r.details["corpus"] == "debugging-smoke" for r in results)


# --------------------------------------------------------------------------
# scenario_run_fn: TrialRecord -> CaseRun field mapping
# --------------------------------------------------------------------------


def test_scenario_run_fn_maps_pipeline_result_fields_onto_case_run(registry):
    cases = load_corpus_from_scenarios(families=["debugging"], registry=registry)
    case = next(c for c in cases if c.name == "csv-sum-offbyone@1")

    run_fn = scenario_run_fn(
        test_runner=_always_passing_test_runner,
        pipeline_factory=_stub_pipeline_factory(
            changed_files=["summer.py"],
            diff="--- a/summer.py\n+++ b/summer.py\n@@\n-x\n+y\n",
            denied=["rm -rf /"],
            metrics={"tokens": 123.0, "tool_calls": 4.0, "duration_s": 5.5},
        ),
    )

    case_run = run_fn(case.objective)

    assert isinstance(case_run, CaseRun)
    assert case_run.result.status.value == "success"
    assert case_run.result.changed_files == ["summer.py"]
    assert "summer.py" in case_run.diff
    assert case_run.denied_commands == [{"command": "rm -rf /"}]
    assert case_run.tokens_used == 123
    assert case_run.runtime_seconds == 5.5


def test_scenario_run_fn_raises_a_clear_error_for_an_unrelated_objective(registry):
    # Ensures the corpus load happened so the lookup is populated, then
    # exercises it with an objective that was never built by
    # load_corpus_from_scenarios.
    load_corpus_from_scenarios(families=["debugging"], registry=registry)
    run_fn = scenario_run_fn(
        test_runner=_always_passing_test_runner, pipeline_factory=_stub_pipeline_factory()
    )
    bogus = Objective(type="qa", repo="/nowhere/at/all", title="not a scenario")
    with pytest.raises(KeyError):
        run_fn(bogus)


# --------------------------------------------------------------------------
# load_corpus: deleted-YAML error message
# --------------------------------------------------------------------------


def test_load_corpus_missing_legacy_yaml_points_at_the_scenario_adapter(tmp_path):
    missing = tmp_path / "does-not-exist.yaml"
    with pytest.raises(FileNotFoundError, match="load_corpus_from_scenarios"):
        load_corpus(missing)


def test_load_corpus_still_loads_a_real_out_of_tree_yaml(tmp_path):
    corpus_yaml = tmp_path / "custom.yaml"
    corpus_yaml.write_text(
        """
name: custom-regression
cases:
  - name: c1
    objective:
      type: add-feature
      repo: some-repo
      title: Do a thing
      acceptanceCriteria: ["it happens"]
    expect:
      status: success
      changesPaths: ["*.py"]
      forbidsDeniedCommands: true
      maxChangedFiles: 3
"""
    )
    suite_name, cases = load_corpus(corpus_yaml)
    assert suite_name == "custom-regression"
    assert len(cases) == 1
    assert cases[0].name == "c1"
    assert cases[0].expect.max_changed_files == 3
