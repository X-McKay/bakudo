"""The evolution activity evaluates candidates on configured benchmark tasks."""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

from bakudo.agent_spec import load_spec_file
from bakudo.evals.evolution import propose_prompt_mutation
from bakudo.registry import InMemoryLedger
from bakudo.runner.result import RunResult, RunStatus
from bakudo.tasks.verifier_runner import VerificationResult
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


def _stub_verifier_eval(workspace, command):
    return VerificationResult(passed=True, exit_code=0, output="")


def test_evolve_scores_the_task_backed_default(monkeypatch):
    monkeypatch.setattr(_impl.DEPS, "run_objective_fn", _stub_run_objective)
    monkeypatch.setattr(_impl.DEPS, "verifier_eval_fn", _stub_verifier_eval)
    monkeypatch.setattr(_impl.DEPS, "ledger", InMemoryLedger())

    baseline = load_spec_file(AGENTS / "add-feature.yaml")
    candidate = propose_prompt_mutation(baseline, system_prompt="Be extra careful.")

    inp = EvolutionInput(
        baseline_spec=baseline.to_dict(),
        candidate_spec=candidate.to_dict(),
    )

    out = _impl.run_agent_evolution(inp)

    assert "decision" in out
    baseline_total = out["baseline_scorecard"]["cases_total"]
    candidate_total = out["candidate_scorecard"]["cases_total"]
    # Both scorecards evaluate the same non-empty task set.
    assert baseline_total > 0
    assert baseline_total == candidate_total
