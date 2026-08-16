"""Task 7: ``run_agent_evolution``'s scenario-backed default corpus.

``EvolutionInput.corpus_path=None`` routes ``_impl.run_agent_evolution`` to
``load_corpus_from_scenarios(families=["debugging", "no-change"])``, run via
``_scenario_case_run_fn`` (the trial-substrate bridge) rather than the legacy
``_run_case``. This is an offline smoke test: ``DEPS.run_objective_fn`` and
``DEPS.hidden_eval_fn`` are stubbed so no real sandbox, model, or subprocess
call happens.
"""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

from bakudo.agent_spec import load_spec_file
from bakudo.evals.evolution import propose_prompt_mutation
from bakudo.registry import InMemoryLedger
from bakudo.runner.result import RunResult, RunStatus
from bakudo.scenarios.testrun import TestRunResult
from bakudo.temporal import _impl
from bakudo.temporal.shared import EvolutionInput

AGENTS = Path(__file__).resolve().parents[1] / "agents"


def _stub_run_objective(objective, spec, *, sandbox):
    result = RunResult(
        run_id="run_evo",
        agent=spec.ref,
        objective_id=objective.id,
        status=RunStatus.success,
        summary="stub run",
        changed_files=[],
    )
    outcome = SimpleNamespace(
        diff="", denied_commands=[], observability={}, tokens_used=0, runtime_seconds=0.0
    )
    return SimpleNamespace(outcome=outcome, result=result, scorecard=None)


def _stub_hidden_eval(workspace, command):
    return TestRunResult(passed=True, exit_code=0, output="")


def test_evolve_with_no_corpus_path_scores_the_scenario_backed_default(monkeypatch):
    monkeypatch.setattr(_impl.DEPS, "run_objective_fn", _stub_run_objective)
    monkeypatch.setattr(_impl.DEPS, "hidden_eval_fn", _stub_hidden_eval)
    monkeypatch.setattr(_impl.DEPS, "ledger", InMemoryLedger())

    baseline = load_spec_file(AGENTS / "add-feature.yaml")
    candidate = propose_prompt_mutation(baseline, system_prompt="Be extra careful.")

    inp = EvolutionInput(
        baseline_spec=baseline.to_dict(),
        candidate_spec=candidate.to_dict(),
        corpus_path=None,
    )

    out = _impl.run_agent_evolution(inp)

    assert "decision" in out
    baseline_total = out["baseline_scorecard"]["cases_total"]
    candidate_total = out["candidate_scorecard"]["cases_total"]
    # The debugging + no-change families are non-empty in the exemplar
    # registry, and both scorecards score the exact same corpus.
    assert baseline_total > 0
    assert baseline_total == candidate_total


def test_evolve_with_explicit_corpus_path_still_uses_the_legacy_run_fn(monkeypatch, tmp_path):
    """An explicit ``corpus_path`` is still honored (out-of-tree corpora),
    routed through the unchanged ``_run_case``/sandbox path -- never through
    the scenario-aware bridge."""
    calls = {"run_case": 0, "scenario_case": 0}

    def spy_run_case(spec, objective):
        calls["run_case"] += 1
        result = RunResult(
            run_id="r", agent=spec.ref, objective_id=objective.id,
            status=RunStatus.success, summary="ok", changed_files=[],
        )
        from bakudo.evals.corpus import CaseRun

        return CaseRun(result=result)

    def spy_scenario_case(spec, objective):
        calls["scenario_case"] += 1
        raise AssertionError("must not be called for an explicit corpus_path")

    monkeypatch.setattr(_impl, "_run_case", spy_run_case)
    monkeypatch.setattr(_impl, "_scenario_case_run_fn", spy_scenario_case)
    monkeypatch.setattr(_impl.DEPS, "ledger", InMemoryLedger())

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
      forbidsDeniedCommands: true
"""
    )

    baseline = load_spec_file(AGENTS / "add-feature.yaml")
    candidate = propose_prompt_mutation(baseline, system_prompt="Be extra careful.")
    inp = EvolutionInput(
        baseline_spec=baseline.to_dict(),
        candidate_spec=candidate.to_dict(),
        corpus_path=str(corpus_yaml),
    )

    out = _impl.run_agent_evolution(inp)

    assert "decision" in out
    assert calls["run_case"] == 2  # one case, scored for baseline + candidate
    assert calls["scenario_case"] == 0
