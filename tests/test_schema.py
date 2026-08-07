import pytest

from bakudo.schema import (
    SchemaValidationError,
    validate_eval_result,
    validate_objective,
    validate_result,
)


def test_objective_schema_accepts_minimal():
    validate_objective(
        {"id": "obj_01HZZZZZZZZZZZZZZZZZZZZZZ0", "type": "explore",
         "repo": "r", "title": "t"}
    )


def test_objective_schema_rejects_bad_id():
    with pytest.raises(SchemaValidationError):
        validate_objective({"id": "nope", "type": "explore", "repo": "r", "title": "t"})


def test_result_schema_requires_identity_fields():
    with pytest.raises(SchemaValidationError):
        validate_result({"status": "success", "summary": "s"})


def test_eval_result_schema_round_trips():
    validate_eval_result(
        {"subject_type": "run", "subject_id": "run_X", "suite_name": "safety",
         "score": 1.0, "passed": True, "details": {"cases_total": 1}}
    )


def test_eval_result_score_bounds():
    with pytest.raises(SchemaValidationError):
        validate_eval_result(
            {"subject_type": "run", "subject_id": "x", "suite_name": "s",
             "score": 1.5, "passed": True}
        )
