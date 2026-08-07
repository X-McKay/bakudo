"""The EvalResult model mirroring ``schemas/eval-result.schema.json`` (section 22.3)."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from ..schema import validate_eval_result


class EvalResult(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    subject_type: str
    subject_id: str
    suite_name: str
    score: float = Field(ge=0.0, le=1.0)
    passed: bool
    details: dict[str, Any] = Field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return self.model_dump(mode="json")

    def validate_against_schema(self) -> None:
        validate_eval_result(self.to_dict())
