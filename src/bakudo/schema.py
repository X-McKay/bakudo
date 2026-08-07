"""Loading and validation against the JSON Schemas in ``schemas/``.

These schemas are the contract between planes and across languages, so we
validate against the on-disk JSON (rather than only the pydantic models) at the
trust boundaries: when a worker writes ``result.json``, when an objective is
submitted, and when a candidate AgentSpec is created.
"""

from __future__ import annotations

import json
from functools import cache
from typing import Any

from jsonschema import Draft202012Validator

from .paths import schemas_dir


@cache
def _validator(schema_filename: str) -> Draft202012Validator:
    path = schemas_dir() / schema_filename
    schema = json.loads(path.read_text())
    Draft202012Validator.check_schema(schema)
    return Draft202012Validator(schema)


class SchemaValidationError(ValueError):
    """Raised when a document does not conform to its JSON Schema."""

    def __init__(self, schema_filename: str, errors: list[str]):
        self.schema_filename = schema_filename
        self.errors = errors
        joined = "\n  - ".join(errors)
        super().__init__(f"{schema_filename} validation failed:\n  - {joined}")


def validate(document: Any, schema_filename: str) -> None:
    """Validate ``document`` against a named schema, raising on failure."""
    validator = _validator(schema_filename)
    errors = sorted(validator.iter_errors(document), key=lambda e: list(e.path))
    if errors:
        messages = [
            f"{'/'.join(str(p) for p in err.path) or '<root>'}: {err.message}"
            for err in errors
        ]
        raise SchemaValidationError(schema_filename, messages)


def is_valid(document: Any, schema_filename: str) -> bool:
    return _validator(schema_filename).is_valid(document)


# Convenience wrappers naming each contract.
def validate_agent_spec(document: Any) -> None:
    validate(document, "agent-spec.schema.json")


def validate_objective(document: Any) -> None:
    validate(document, "objective.schema.json")


def validate_result(document: Any) -> None:
    validate(document, "result.schema.json")


def validate_eval_result(document: Any) -> None:
    validate(document, "eval-result.schema.json")
