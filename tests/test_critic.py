from bakudo.curriculum import Objective
from bakudo.evals.checks import EvalContext
from bakudo.evals.critic import critic_eval
from bakudo.runner.result import RunResult


def _ctx():
    result = RunResult.model_validate({
        "run_id": "run_X", "agent": "add-feature@1", "objective_id": "obj_X",
        "status": "success", "summary": "did it", "changed_files": ["a.py"],
    })
    return EvalContext(result=result, objective=Objective(type="add-feature", repo="r", title="t"),
                       diff="--- a/a.py\n+++ b/a.py\n+code\n")


def test_critic_abstains_without_judge():
    res = critic_eval(_ctx())
    assert res.passed is True
    assert res.details["abstained"] is True


def test_critic_fails_on_judge_issues():
    def judge(prompt):
        assert "reviewer" in prompt
        return {"score": 0.2, "passed": False, "issues": ["no tests", "race condition"]}

    res = critic_eval(_ctx(), judge=judge)
    assert res.passed is False
    assert res.score == 0.2
    assert res.details["issue_count"] == 2


def test_critic_passes_on_clean_judge():
    res = critic_eval(_ctx(), judge=lambda p: {"score": 0.95, "passed": True, "issues": []})
    assert res.passed is True
    assert res.score == 0.95
