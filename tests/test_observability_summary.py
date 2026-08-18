from __future__ import annotations

import pytest

from bakudo.observability import (
    ObservabilitySummary,
    SpanContext,
    SpanName,
    SpanRecord,
    SpanStatus,
    summarize_spans,
)


def _record(
    name: SpanName,
    *,
    trace: str,
    span: str,
    start: float,
    end: float,
    parent: str | None = None,
    status: SpanStatus = SpanStatus.OK,
) -> SpanRecord:
    return SpanRecord(
        name=name,
        context=SpanContext(trace_id=trace, span_id=span),
        parent_span_id=parent,
        started_monotonic_ns=int(start * 1_000_000_000),
        ended_monotonic_ns=int(end * 1_000_000_000),
        status=status,
    )


def test_empty_summary_is_explicitly_zero() -> None:
    assert summarize_spans([]) == ObservabilitySummary(0, 0, 0.0, 0.0, 0.0, ())


def test_summary_calculates_percentiles_outcomes_and_phase_attribution() -> None:
    records = [
        _record(SpanName.RUN, trace="a", span="a-root", start=0, end=10),
        _record(
            SpanName.SANDBOX_PREPARE,
            trace="a",
            span="a-sandbox",
            parent="a-root",
            start=1,
            end=3,
        ),
        _record(
            SpanName.MODEL_GENERATE,
            trace="a",
            span="a-model",
            parent="a-root",
            start=3,
            end=7,
        ),
        _record(
            SpanName.VERIFIER_RUN,
            trace="a",
            span="a-verify",
            parent="a-root",
            start=7,
            end=9,
        ),
        _record(SpanName.RUN, trace="b", span="b-root", start=0, end=20),
        _record(
            SpanName.SANDBOX_PREPARE,
            trace="b",
            span="b-sandbox",
            parent="b-root",
            start=2,
            end=6,
        ),
        _record(
            SpanName.MODEL_GENERATE,
            trace="b",
            span="b-model",
            parent="b-root",
            start=6,
            end=16,
            status=SpanStatus.TIMEOUT,
        ),
        _record(
            SpanName.VERIFIER_RUN,
            trace="b",
            span="b-verify",
            parent="b-root",
            start=16,
            end=18,
            status=SpanStatus.ERROR,
        ),
    ]

    summary = summarize_spans(records)
    phases = {phase.name: phase for phase in summary.phases}

    assert summary.trace_count == 2
    assert summary.span_count == 8
    assert summary.total_trace_seconds == pytest.approx(30.0)
    assert summary.p50_trace_seconds == pytest.approx(15.0)
    assert summary.p95_trace_seconds == pytest.approx(19.5)

    assert phases[SpanName.RUN].exclusive_seconds == pytest.approx(6.0)
    assert phases[SpanName.SANDBOX_PREPARE].p50_seconds == pytest.approx(3.0)
    assert phases[SpanName.SANDBOX_PREPARE].p95_seconds == pytest.approx(3.9)
    assert phases[SpanName.MODEL_GENERATE].exclusive_seconds == pytest.approx(14.0)
    assert phases[SpanName.MODEL_GENERATE].attribution == pytest.approx(14 / 30)
    assert phases[SpanName.MODEL_GENERATE].timeout_count == 1
    assert phases[SpanName.MODEL_GENERATE].timeout_rate == pytest.approx(0.5)
    assert phases[SpanName.VERIFIER_RUN].error_count == 1
    assert phases[SpanName.VERIFIER_RUN].error_rate == pytest.approx(0.5)
    assert sum(phase.attribution for phase in summary.phases) == pytest.approx(1.0)


def test_summary_treats_missing_parent_as_root() -> None:
    summary = summarize_spans(
        [
            _record(
                SpanName.QUEUE_WAIT,
                trace="trace",
                span="child-only",
                parent="not-exported",
                start=4,
                end=7,
            )
        ]
    )

    assert summary.trace_count == 1
    assert summary.total_trace_seconds == pytest.approx(3.0)
    assert summary.phases[0].attribution == pytest.approx(1.0)
