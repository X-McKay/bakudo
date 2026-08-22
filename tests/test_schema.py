import pytest

from bakudo.schema import (
    SchemaValidationError,
    validate_eval_result,
    validate_objective,
    validate_product_agent_result,
    validate_result,
)


def test_objective_schema_accepts_minimal():
    validate_objective(
        {"id": "obj_01HZZZZZZZZZZZZZZZZZZZZZZ0", "type": "explore", "repo": "r", "title": "t"}
    )


def test_objective_schema_rejects_bad_id():
    with pytest.raises(SchemaValidationError):
        validate_objective({"id": "nope", "type": "explore", "repo": "r", "title": "t"})


def test_result_schema_requires_identity_fields():
    with pytest.raises(SchemaValidationError):
        validate_result({"status": "success", "summary": "s"})


def test_eval_result_schema_round_trips():
    validate_eval_result(
        {
            "subject_type": "run",
            "subject_id": "run_X",
            "suite_name": "safety",
            "score": 1.0,
            "passed": True,
            "details": {"cases_total": 1},
        }
    )


def test_eval_result_score_bounds():
    with pytest.raises(SchemaValidationError):
        validate_eval_result(
            {
                "subject_type": "run",
                "subject_id": "x",
                "suite_name": "s",
                "score": 1.5,
                "passed": True,
            }
        )


def test_product_agent_schema_forbids_scores_and_requires_runtime_diagnostics():
    document = {
        "schema": "bakudo.product-agent/v1",
        "run_id": "run_01HZZZZZZZZZZZZZZZZZZZZZZ0",
        "status": "completed",
        "reason_code": None,
        "patch": {
            "path": "candidate.patch",
            "format": "git-diff-binary-v1",
            "digest": "sha256:" + "0" * 64,
            "size_bytes": 0,
            "changed_files": [],
        },
        "usage": {
            "wall_time_ms": 0,
            "tokens": 0,
            "model_calls": 0,
            "tool_calls": 0,
            "denied_commands": 0,
        },
        "runtime": {
            "bakudo_version": "3.0.0",
            "agent_ref": "add-feature@1",
            "agent_spec_digest": "sha256:" + "1" * 64,
            "skills_digest": "sha256:" + "2" * 64,
            "abox_version": "0.7.2",
            "attested": False,
        },
    }
    validate_product_agent_result(document)
    with pytest.raises(SchemaValidationError):
        validate_product_agent_result({**document, "score": 1})
    with pytest.raises(SchemaValidationError):
        validate_product_agent_result(
            {
                **document,
                "patch": {**document["patch"], "changed_files": ["../outside"]},
            }
        )
    with pytest.raises(SchemaValidationError):
        validate_product_agent_result(
            {**document, "status": "blocked", "reason_code": "sandbox_timeout"}
        )


def test_runner_writes_diagnosable_result_on_incompatible_bundle(tmp_path):
    """Control-plane/worker-plane version skew: a bundle carrying fields this
    (older) runner doesn't know must still produce a failed result.json with
    a diagnosis — not die silently before the result exists (observed live:
    stale vendored wheel + enableThinking bundle)."""
    import argparse
    import json

    from bakudo.runner.main import run as runner_run

    bundle_doc = {
        "run_id": "run_SKEW01",
        "objective_id": "obj_SKEW01",
        "objective": {"id": "obj_SKEW01", "type": "explore", "repo": "r", "title": "t"},
        "agent_spec": {"totally": "incompatible"},
    }
    bp = tmp_path / "bundle.json"
    bp.write_text(json.dumps(bundle_doc))
    rp = tmp_path / "result.json"
    args = argparse.Namespace(
        bundle=str(bp),
        result=str(rp),
        workspace=str(tmp_path),
        spec=None,
        objective=None,
        run_id=None,
    )
    rc = runner_run(args)
    assert rc != 0
    out = json.loads(rp.read_text())
    assert out["status"] == "failed"
    assert out["run_id"] == "run_SKEW01"
    assert "bundle" in out["summary"].lower()
    assert "bundle_incompatible" in out["blocked_reasons"]
