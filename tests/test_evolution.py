from pathlib import Path

from bakudo.agent_spec import load_spec_file
from bakudo.curriculum import Objective
from bakudo.evals.corpus import CaseRun, EvalCase, Expectations
from bakudo.evals.evolution import (
    evolve_agent,
    infer_mutation_kinds,
    propose_prompt_mutation,
)
from bakudo.evals.promotion import Decision
from bakudo.runner.result import RunResult

AGENTS = Path(__file__).resolve().parents[1] / "agents"


def _spec():
    return load_spec_file(AGENTS / "add-feature.yaml")


def _cases(n=30):
    return [
        EvalCase(
            name=f"c{i}",
            objective=Objective(type="add-feature", repo="r", title=f"t{i}",
                                acceptanceCriteria=["do it"]),
            expect=Expectations(changes_paths=["*.py"]),
        )
        for i in range(n)
    ]


def test_prompt_mutation_makes_a_candidate_child_version():
    base = _spec()
    cand = propose_prompt_mutation(base, system_prompt="Be even more careful.")
    assert cand.metadata.version == base.metadata.version + 1
    assert cand.metadata.status.value == "candidate"
    assert cand.metadata.parent_version == base.metadata.version
    assert cand.prompt.system == "Be even more careful."


def test_infer_mutation_kinds_detects_broadened_network():
    base = _spec()
    widened = base.model_copy(
        update={"sandbox": base.sandbox.model_copy(
            update={"network_bundles": [*base.sandbox.network_bundles, "internal-lan"]}
        )}
    )
    assert "broader-network-access" in infer_mutation_kinds(base, widened)


def test_evolve_agent_promotes_better_candidate():
    base = _spec()
    cand = propose_prompt_mutation(base, system_prompt="Better prompt.")

    def run_fn(spec, objective):
        # The candidate (v2) "performs better": it changes a file and passes.
        good = spec.metadata.version == cand.metadata.version
        result = RunResult.model_validate({
            "run_id": "r", "agent": spec.ref, "objective_id": objective.id,
            "status": "success" if good else "blocked",
            "summary": "s", "changed_files": ["a.py"] if good else [],
            "tests_run": [{"command": "pytest", "status": "passed" if good else "failed"}],
        })
        return CaseRun(result=result, diff="")

    outcome = evolve_agent(base, cand, _cases(30), run_fn)
    assert outcome.candidate.overall_score > outcome.baseline.overall_score
    assert outcome.decision.decision is Decision.canary
