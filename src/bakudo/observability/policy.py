"""Safe, low-cardinality attributes for Bakudo phase spans.

Observability attributes are deliberately a closed vocabulary.  Free-form
values belong in application logs or protected artifacts, not in telemetry
dimensions where they can leak secrets and create unbounded cardinality.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass
from enum import Enum
from typing import TypeAlias


class SpanAttribute(str, Enum):
    """Attribute names that may cross the telemetry boundary."""

    RUN_ID = "run.id"
    TRIAL_ID = "trial.id"
    EPISODE_ID = "episode.id"
    EXPERIMENT_ID = "experiment.id"
    WORKFLOW_ID = "workflow.id"
    ACTIVITY_ID = "activity.id"
    OBJECTIVE_ID = "objective.id"
    TASK_ID = "task.id"
    MEASUREMENT_ID = "measurement.id"
    SNAPSHOT_ID = "snapshot.id"
    COMPARISON_ID = "comparison.id"
    REPOSITORY_ID = "repository.id"

    ROLE = "role"
    PHASE = "phase"
    STATUS = "status"
    ADAPTER = "adapter"
    WORKLOAD_NAME = "workload.name"
    WORKLOAD_VERSION = "workload.version"
    TASK_NAME = "task.name"
    TASK_VERSION = "task.version"
    MODEL_ID = "model.id"
    WORKER_PROFILE = "worker.profile"
    TOOL_NAME = "tool.name"
    VERIFIER_NAME = "verifier.name"
    METRIC_NAME = "metric.name"
    ERROR_TYPE = "error.type"

    ATTEMPT_NUMBER = "attempt.number"
    ITERATION_NUMBER = "iteration.number"
    INPUT_TOKEN_COUNT = "input_token.count"
    OUTPUT_TOKEN_COUNT = "output_token.count"
    TOOL_CALL_COUNT = "tool_call.count"
    SAMPLE_COUNT = "sample.count"
    ITEM_COUNT = "item.count"
    BYTE_COUNT = "byte.count"
    WORKER_COUNT = "worker.count"
    QUEUE_DEPTH = "queue.depth"


AttributeValue: TypeAlias = str | int | float | bool
AttributeKey: TypeAlias = SpanAttribute | str

_STRING_ATTRIBUTES = frozenset(
    attribute.value
    for attribute in SpanAttribute
    if attribute
    not in {
        SpanAttribute.ATTEMPT_NUMBER,
        SpanAttribute.ITERATION_NUMBER,
        SpanAttribute.INPUT_TOKEN_COUNT,
        SpanAttribute.OUTPUT_TOKEN_COUNT,
        SpanAttribute.TOOL_CALL_COUNT,
        SpanAttribute.SAMPLE_COUNT,
        SpanAttribute.ITEM_COUNT,
        SpanAttribute.BYTE_COUNT,
        SpanAttribute.WORKER_COUNT,
        SpanAttribute.QUEUE_DEPTH,
    }
)
_COUNT_ATTRIBUTES = frozenset(attribute.value for attribute in SpanAttribute) - _STRING_ATTRIBUTES
_SAFE_TOKEN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/@+\-]*$")
_SECRET_VALUE = re.compile(
    r"(?:^sk-[A-Za-z0-9_-]+$|^ghp_[A-Za-z0-9]+$|^github_pat_[A-Za-z0-9_]+$|"
    r"^AKIA[A-Z0-9]+$|bearer|password|passwd|api[_-]?key|authorization|token=)",
    re.IGNORECASE,
)


def _attribute_name(key: AttributeKey) -> str:
    return key.value if isinstance(key, SpanAttribute) else key


@dataclass(frozen=True)
class AttributePolicy:
    """Validate attributes without raising or retaining rejected values."""

    max_string_length: int = 128
    max_count: int = 1_000_000_000_000_000

    def sanitize(
        self, attributes: Mapping[AttributeKey, object] | None
    ) -> dict[str, AttributeValue]:
        """Return only known keys whose values are safe telemetry dimensions.

        Unknown keys, free-form strings, secrets, non-finite numbers, booleans,
        and out-of-range counts are omitted.  Omission is intentional: a
        tracing failure or unsafe diagnostic value must never fail the run.
        """

        if not attributes:
            return {}

        safe: dict[str, AttributeValue] = {}
        for raw_key, value in attributes.items():
            key = _attribute_name(raw_key)
            sanitized: AttributeValue | None
            if key in _STRING_ATTRIBUTES:
                sanitized = self._safe_string(value)
            elif key in _COUNT_ATTRIBUTES:
                sanitized = self._safe_count(value)
            else:
                continue
            if sanitized is not None:
                safe[key] = sanitized
        return safe

    def _safe_string(self, value: object) -> str | None:
        if not isinstance(value, str) or not value or len(value) > self.max_string_length:
            return None
        if ".." in value.split("/") or not _SAFE_TOKEN.fullmatch(value):
            return None
        if _SECRET_VALUE.search(value):
            return None
        return value

    def _safe_count(self, value: object) -> int | None:
        if isinstance(value, bool) or not isinstance(value, int):
            return None
        if not 0 <= value <= self.max_count:
            return None
        return value


DEFAULT_ATTRIBUTE_POLICY = AttributePolicy()


def sanitize_attributes(
    attributes: Mapping[AttributeKey, object] | None,
) -> dict[str, AttributeValue]:
    """Sanitize attributes with Bakudo's canonical telemetry policy."""

    return DEFAULT_ATTRIBUTE_POLICY.sanitize(attributes)
