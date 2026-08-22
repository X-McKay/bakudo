"""Strict v1 output contracts for Bakudo's no-eval product-agent command."""

from __future__ import annotations

import re
from enum import Enum
from pathlib import PurePosixPath
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from ..schema import validate_product_agent_result

PRODUCT_AGENT_SCHEMA_V1 = "bakudo.product-agent/v1"
PATCH_FILENAME = "candidate.patch"
PATCH_FORMAT_V1 = "git-diff-binary-v1"

_DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
_RUN_ID = re.compile(r"^run_[0-9A-HJKMNP-TV-Z]{26}$")


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ProductAgentStatus(str, Enum):
    completed = "completed"
    blocked = "blocked"
    failed = "failed"
    timed_out = "timed_out"
    cancelled = "cancelled"


class ProductAgentReason(str, Enum):
    agent_blocked = "agent_blocked"
    agent_failed = "agent_failed"
    sandbox_failed = "sandbox_failed"
    sandbox_unavailable = "sandbox_unavailable"
    sandbox_timeout = "sandbox_timeout"
    cancelled = "cancelled"
    output_policy_violation = "output_policy_violation"


class PatchMetadata(_Strict):
    path: Literal["candidate.patch"] = "candidate.patch"
    format: Literal["git-diff-binary-v1"] = "git-diff-binary-v1"
    digest: str
    size_bytes: int = Field(ge=0)
    changed_files: tuple[str, ...] = ()

    @model_validator(mode="after")
    def validate_identity(self) -> PatchMetadata:
        if _DIGEST.fullmatch(self.digest) is None:
            raise ValueError("patch.digest must be a lowercase sha256 digest")
        if self.changed_files != tuple(sorted(set(self.changed_files))):
            raise ValueError("patch.changed_files must be unique and sorted")
        for value in self.changed_files:
            try:
                encoded = value.encode("utf-8", errors="strict")
            except UnicodeEncodeError as exc:
                raise ValueError("patch.changed_files paths must be valid UTF-8") from exc
            path = PurePosixPath(value)
            if (
                not value
                or len(encoded) > 4096
                or path.is_absolute()
                or path.as_posix() != value
                or any(part in {"", ".", ".."} for part in path.parts)
                or any(ord(character) < 32 or ord(character) == 127 for character in value)
            ):
                raise ValueError("patch.changed_files contains an invalid path")
        return self


class UsageMetadata(_Strict):
    wall_time_ms: int = Field(ge=0)
    tokens: int = Field(ge=0)
    model_calls: int = Field(ge=0)
    tool_calls: int = Field(ge=0)
    denied_commands: int = Field(ge=0)


class RuntimeMetadata(_Strict):
    """Runner-observed diagnostics, explicitly not an attestation."""

    bakudo_version: str = Field(min_length=1, max_length=128)
    agent_ref: str = Field(min_length=1, max_length=256)
    agent_spec_digest: str
    skills_digest: str
    abox_version: Literal["0.7.2"]
    attested: Literal[False] = False

    @model_validator(mode="after")
    def validate_digests(self) -> RuntimeMetadata:
        for name, value in (
            ("agent_spec_digest", self.agent_spec_digest),
            ("skills_digest", self.skills_digest),
        ):
            if _DIGEST.fullmatch(value) is None:
                raise ValueError(f"runtime.{name} must be a lowercase sha256 digest")
        return self


class ProductAgentResult(_Strict):
    """The complete public result.  There is intentionally no score field."""

    schema_name: Literal["bakudo.product-agent/v1"] = Field(
        default="bakudo.product-agent/v1",
        alias="schema",
    )
    run_id: str
    status: ProductAgentStatus
    reason_code: ProductAgentReason | None
    patch: PatchMetadata
    usage: UsageMetadata
    runtime: RuntimeMetadata

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    @model_validator(mode="after")
    def validate_terminal_reason(self) -> ProductAgentResult:
        if _RUN_ID.fullmatch(self.run_id) is None:
            raise ValueError("run_id must be a canonical Bakudo run ID")
        allowed: dict[ProductAgentStatus, set[ProductAgentReason | None]] = {
            ProductAgentStatus.completed: {None},
            ProductAgentStatus.blocked: {ProductAgentReason.agent_blocked},
            ProductAgentStatus.failed: {
                ProductAgentReason.agent_failed,
                ProductAgentReason.sandbox_failed,
                ProductAgentReason.sandbox_unavailable,
                ProductAgentReason.output_policy_violation,
            },
            ProductAgentStatus.timed_out: {ProductAgentReason.sandbox_timeout},
            ProductAgentStatus.cancelled: {ProductAgentReason.cancelled},
        }
        if self.reason_code not in allowed[self.status]:
            raise ValueError(f"reason_code is not valid for status {self.status.value!r}")
        return self

    def to_dict(self) -> dict[str, Any]:
        document = self.model_dump(by_alias=True, mode="json")
        validate_product_agent_result(document)
        return document
