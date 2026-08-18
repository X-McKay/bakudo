"""Vendor-neutral self-observability primitives for Bakudo."""

from bakudo.observability.policy import (
    DEFAULT_ATTRIBUTE_POLICY,
    AttributeKey,
    AttributePolicy,
    AttributeValue,
    SpanAttribute,
    sanitize_attributes,
)
from bakudo.observability.spans import (
    NOOP_SPAN_SINK,
    ActiveSpan,
    FakeSpanSink,
    NoOpSpanSink,
    SpanContext,
    SpanName,
    SpanRecord,
    SpanSink,
    SpanStatus,
    current_span_context,
    phase_span,
)
from bakudo.observability.summary import ObservabilitySummary, PhaseSummary, summarize_spans

__all__ = [
    "DEFAULT_ATTRIBUTE_POLICY",
    "NOOP_SPAN_SINK",
    "ActiveSpan",
    "AttributeKey",
    "AttributePolicy",
    "AttributeValue",
    "FakeSpanSink",
    "NoOpSpanSink",
    "ObservabilitySummary",
    "PhaseSummary",
    "SpanAttribute",
    "SpanContext",
    "SpanName",
    "SpanRecord",
    "SpanSink",
    "SpanStatus",
    "current_span_context",
    "phase_span",
    "sanitize_attributes",
    "summarize_spans",
]
