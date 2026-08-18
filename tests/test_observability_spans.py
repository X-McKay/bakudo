from __future__ import annotations

import asyncio
from collections.abc import Iterator

import pytest

from bakudo.observability import (
    NOOP_SPAN_SINK,
    FakeSpanSink,
    SpanAttribute,
    SpanName,
    SpanRecord,
    SpanStatus,
    current_span_context,
    phase_span,
)


class TickClock:
    def __init__(self, *ticks: int) -> None:
        self._ticks: Iterator[int] = iter(ticks)

    def __call__(self) -> int:
        return next(self._ticks)


class BrokenSink:
    def emit(self, record: SpanRecord) -> None:
        del record
        raise RuntimeError("exporter contained a secret")


def test_fake_sink_records_nested_monotonic_phase_spans() -> None:
    sink = FakeSpanSink()
    clock = TickClock(0, 2_000_000_000, 5_000_000_000, 10_000_000_000)

    with phase_span(
        SpanName.RUN,
        sink=sink,
        attributes={SpanAttribute.RUN_ID: "run-1"},
        clock=clock,
    ) as outer:
        assert current_span_context() == outer.context
        with phase_span(SpanName.SANDBOX_PREPARE, sink=sink, clock=clock) as child:
            assert child.context.trace_id == outer.context.trace_id
            assert current_span_context() == child.context
        assert current_span_context() == outer.context

    assert current_span_context() is None
    child_record, outer_record = sink.records
    assert child_record.parent_span_id == outer.context.span_id
    assert child_record.duration_seconds == pytest.approx(3.0)
    assert outer_record.parent_span_id is None
    assert outer_record.duration_seconds == pytest.approx(10.0)
    assert outer_record.attributes == {"run.id": "run-1"}


def test_explicit_parent_propagates_trace_context() -> None:
    sink = FakeSpanSink()
    with phase_span(SpanName.RUN, sink=sink) as outer:
        propagated = outer.context

    with phase_span(SpanName.LEDGER_PERSIST, sink=sink, parent=propagated):
        pass

    child = sink.records[-1]
    assert child.context.trace_id == propagated.trace_id
    assert child.parent_span_id == propagated.span_id


@pytest.mark.parametrize(
    ("error", "status"),
    [
        (RuntimeError("private message"), SpanStatus.ERROR),
        (TimeoutError("private timeout"), SpanStatus.TIMEOUT),
        (asyncio.CancelledError("private cancellation"), SpanStatus.CANCELLED),
    ],
)
def test_error_paths_close_span_without_exporting_raw_error(
    error: BaseException, status: SpanStatus
) -> None:
    sink = FakeSpanSink()

    with pytest.raises(type(error), match="private"):
        with phase_span(SpanName.VERIFIER_RUN, sink=sink):
            raise error

    assert sink.records[0].status is status
    assert sink.records[0].attributes == {"error.type": type(error).__name__}
    assert "private" not in repr(sink.records[0])


def test_active_span_accepts_safe_updates_and_explicit_status() -> None:
    sink = FakeSpanSink()

    with phase_span(SpanName.TOOL_EXECUTE, sink=sink) as active:
        active.set_attribute(SpanAttribute.TOOL_NAME, "read_file")
        active.set_attribute("tool.arguments", "secret payload")
        active.set_status(SpanStatus.TIMEOUT)

    record = sink.records[0]
    assert record.status is SpanStatus.TIMEOUT
    assert record.attributes == {"tool.name": "read_file"}


def test_exporter_failure_does_not_change_operation_result() -> None:
    with phase_span(SpanName.RUN, sink=BrokenSink()):
        answer = 42

    assert answer == 42


def test_noop_sink_is_dependency_free_default() -> None:
    with phase_span(SpanName.RUN, sink=NOOP_SPAN_SINK) as active:
        assert active.context.trace_id


def test_fake_sink_is_bounded_and_clearable() -> None:
    sink = FakeSpanSink(max_records=1)
    with phase_span(SpanName.RUN, sink=sink):
        pass
    with phase_span(SpanName.RUN, sink=sink):
        pass

    assert len(sink.records) == 1
    assert sink.dropped_count == 1

    sink.clear()
    assert sink.records == ()
    assert sink.dropped_count == 0
