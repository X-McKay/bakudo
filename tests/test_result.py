
from pathlib import Path

from bakudo.runner.result import normalize_result

AGENTS = Path(__file__).resolve().parents[1] / "agents"

CTX = dict(run_id="run_X", agent="add-feature@1", objective_id="obj_X")


def test_normalize_from_dict():
    r = normalize_result({"status": "success", "summary": "done"}, **CTX)
    assert r.status.value == "success"
    assert r.run_id == "run_X"
    assert r.agent == "add-feature@1"


def test_normalize_from_json_string():
    r = normalize_result('{"status": "blocked", "summary": "x"}', **CTX)
    assert r.status.value == "blocked"


def test_normalize_extracts_embedded_json_from_prose():
    text = 'Here is my result:\n```json\n{"status": "success", "summary": "ok"}\n```\nThanks!'
    r = normalize_result(text, **CTX)
    assert r.status.value == "success"
    assert r.summary == "ok"


def test_unparseable_becomes_failed():
    r = normalize_result("the model rambled and emitted no json", **CTX)
    assert r.status.value == "failed"
    assert "unparseable_output" in r.blocked_reasons


def test_result_always_validates_against_schema():
    r = normalize_result({"status": "success", "summary": "s"}, **CTX)
    r.validate_against_schema()  # raises if invalid
    assert r.to_dict()["run_id"] == "run_X"


# --- critic verdict folding (design §5: verdict rides the result envelope) ---

def test_normalize_folds_bare_verdict_into_envelope():
    """A critic that answers with the pinned verdict object {score, passed,
    issues} gets folded into a schema-valid RunResult (metrics.score /
    metrics.passed, issues -> proposed_followups) instead of defaulting to a
    summaryless failure."""
    from bakudo.runner.result import normalize_result

    raw = 'Review done.\n```json\n{"score": 0.75, "passed": true, "issues": ["missing tests"]}\n```'
    out = normalize_result(raw, run_id="run_C", agent="critic@1", objective_id="obj_C")
    assert out.status.value == "success"
    assert out.metrics["score"] == 0.75
    assert out.metrics["passed"] == 1.0
    assert out.proposed_followups == ["missing tests"]
    assert "0.75" in out.summary


def test_normalize_verdict_failed_review():
    from bakudo.runner.result import normalize_result

    out = normalize_result({"score": 0.1, "passed": False, "issues": ["broken"]},
                           run_id="run_C", agent="critic@1", objective_id="obj_C")
    assert out.status.value == "success"  # the critic RUN succeeded; the verdict is negative
    assert out.metrics["passed"] == 0.0


def test_unknown_test_status_coerces_to_error():
    """Observed live: a scout recorded its denied test attempt as status
    'denied'; the schema enum rejected it and the run lost its result."""
    result = normalize_result(
        {"status": "blocked", "summary": "s",
         "tests_run": [{"command": "pytest -q", "status": "denied"},
                       {"command": "pytest -q", "status": "passed"},
                       "tests/test_x.py"],
         },
        run_id="run_1", agent="a@1", objective_id="obj_1",
    )
    statuses = [t.status for t in result.tests_run]
    assert statuses == ["error", "passed", "error"]
    result.validate_against_schema()


def test_runner_writes_failed_result_when_normalization_raises(tmp_path, monkeypatch):
    """normalize_result sat outside main.run's guard: any schema-invalid
    output crashed the runner with NO result.json (observed live)."""
    import argparse

    from bakudo.runner import main as runner_main

    def exploding(*a, **k):
        raise RuntimeError("normalization exploded")

    monkeypatch.setattr(runner_main, "normalize_result", exploding)
    monkeypatch.setenv("BAKUDO_OFFLINE", "1")
    args = argparse.Namespace(
        bundle=None, spec=str(AGENTS / "explore.yaml"),
        objective=None, result=str(tmp_path / "result.json"),
        workspace=str(tmp_path), run_id="run_NORM1",
    )
    import json as _json

    from bakudo.curriculum import Objective

    obj = Objective(type="explore", repo="bakudo", title="t")
    objective_path = tmp_path / "objective.json"
    objective_path.write_text(_json.dumps(obj.to_dict()))
    args.objective = str(objective_path)
    rc = runner_main.run(args)
    assert rc == 1
    written = _json.loads((tmp_path / "result.json").read_text())
    assert written["status"] == "failed"
    assert "normalization exploded" in written["summary"]
