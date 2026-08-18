from __future__ import annotations

import pytest

from bakudo.observability import AttributePolicy, SpanAttribute, sanitize_attributes


def test_policy_keeps_only_allowlisted_bounded_dimensions() -> None:
    assert sanitize_attributes(
        {
            SpanAttribute.RUN_ID: "run-01HXYZ",
            SpanAttribute.MODEL_ID: "provider/model-v1",
            SpanAttribute.TOOL_CALL_COUNT: 7,
            "unknown": "not-exported",
        }
    ) == {
        "run.id": "run-01HXYZ",
        "model.id": "provider/model-v1",
        "tool_call.count": 7,
    }


@pytest.mark.parametrize(
    ("key", "value"),
    [
        ("prompt", "explain-the-repository"),
        ("command", "pytest tests"),
        ("environment", "API_KEY=value"),
        ("tool.arguments", "repo/secret.py"),
        ("tool.result", "private-output"),
        ("error.message", "Bearer credential"),
        ("raw.error", "customer payload"),
    ],
)
def test_policy_drops_forbidden_payload_keys(key: str, value: str) -> None:
    assert sanitize_attributes({key: value}) == {}


@pytest.mark.parametrize(
    "value",
    [
        "sk-supersecret",
        "ghp_abcdefghijklmnop",
        "github_pat_private_value",
        "Bearer-secret",
        "password=hunter2",
        "../../private/file",
        "multiline\nvalue",
        "contains spaces",
    ],
)
def test_policy_drops_unsafe_values_even_for_allowlisted_key(value: str) -> None:
    assert sanitize_attributes({SpanAttribute.MODEL_ID: value}) == {}


@pytest.mark.parametrize("value", [-1, True, 1.5, 10**30, "4"])
def test_policy_drops_invalid_counts(value: object) -> None:
    assert sanitize_attributes({SpanAttribute.SAMPLE_COUNT: value}) == {}


def test_policy_bounds_string_and_count_configuration() -> None:
    policy = AttributePolicy(max_string_length=4, max_count=2)

    assert policy.sanitize(
        {
            SpanAttribute.ROLE: "toolong",
            SpanAttribute.SAMPLE_COUNT: 3,
            SpanAttribute.QUEUE_DEPTH: 2,
        }
    ) == {"queue.depth": 2}
