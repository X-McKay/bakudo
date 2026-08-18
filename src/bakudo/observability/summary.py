"""Pure aggregation of completed Bakudo phase spans."""

from __future__ import annotations

import math
from collections import defaultdict
from collections.abc import Iterable
from dataclasses import dataclass

from bakudo.observability.spans import SpanName, SpanRecord, SpanStatus


@dataclass(frozen=True)
class PhaseSummary:
    """Latency and outcome summary for one stable phase name."""

    name: SpanName
    count: int
    inclusive_seconds: float
    exclusive_seconds: float
    attribution: float
    p50_seconds: float
    p95_seconds: float
    error_count: int
    timeout_count: int
    cancelled_count: int
    error_rate: float
    timeout_rate: float


@dataclass(frozen=True)
class ObservabilitySummary:
    """Bounded operational summary; raw spans remain in the telemetry backend."""

    trace_count: int
    span_count: int
    total_trace_seconds: float
    p50_trace_seconds: float
    p95_trace_seconds: float
    phases: tuple[PhaseSummary, ...]


def _percentile(values: list[float], percentile: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    position = (len(ordered) - 1) * percentile
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return ordered[lower]
    fraction = position - lower
    return ordered[lower] + (ordered[upper] - ordered[lower]) * fraction


def _union_ns(intervals: Iterable[tuple[int, int]]) -> int:
    ordered = sorted((start, end) for start, end in intervals if end > start)
    if not ordered:
        return 0
    total = 0
    current_start, current_end = ordered[0]
    for start, end in ordered[1:]:
        if start <= current_end:
            current_end = max(current_end, end)
            continue
        total += current_end - current_start
        current_start, current_end = start, end
    return total + current_end - current_start


def _exclusive_seconds(
    record: SpanRecord, children_by_parent: dict[tuple[str, str], list[SpanRecord]]
) -> float:
    children = children_by_parent.get((record.context.trace_id, record.context.span_id), [])
    child_intervals = (
        (
            max(record.started_monotonic_ns, child.started_monotonic_ns),
            min(record.ended_monotonic_ns, child.ended_monotonic_ns),
        )
        for child in children
    )
    exclusive_ns = max(
        0,
        record.ended_monotonic_ns
        - record.started_monotonic_ns
        - _union_ns(child_intervals),
    )
    return exclusive_ns / 1_000_000_000


def summarize_spans(spans: Iterable[SpanRecord]) -> ObservabilitySummary:
    """Calculate p50/p95, outcomes, and exclusive phase attribution.

    Attribution is the phase's exclusive duration divided by all recorded
    exclusive duration.  Direct child intervals are unioned before subtraction,
    preventing ordinary nested spans from double-counting parent time.
    """

    records = tuple(spans)
    if not records:
        return ObservabilitySummary(0, 0, 0.0, 0.0, 0.0, ())

    children_by_parent: dict[tuple[str, str], list[SpanRecord]] = defaultdict(list)
    by_trace: dict[str, list[SpanRecord]] = defaultdict(list)
    known_spans = {(record.context.trace_id, record.context.span_id) for record in records}
    for record in records:
        by_trace[record.context.trace_id].append(record)
        if record.parent_span_id is not None:
            children_by_parent[(record.context.trace_id, record.parent_span_id)].append(record)

    exclusive_by_record = {
        id(record): _exclusive_seconds(record, children_by_parent) for record in records
    }
    exclusive_total = sum(exclusive_by_record.values())

    phase_records: dict[SpanName, list[SpanRecord]] = defaultdict(list)
    for record in records:
        phase_records[record.name].append(record)

    phases: list[PhaseSummary] = []
    for name in sorted(phase_records, key=lambda phase: phase.value):
        grouped = phase_records[name]
        durations = [record.duration_seconds for record in grouped]
        phase_exclusive = sum(exclusive_by_record[id(record)] for record in grouped)
        error_count = sum(record.status is SpanStatus.ERROR for record in grouped)
        timeout_count = sum(record.status is SpanStatus.TIMEOUT for record in grouped)
        cancelled_count = sum(record.status is SpanStatus.CANCELLED for record in grouped)
        count = len(grouped)
        phases.append(
            PhaseSummary(
                name=name,
                count=count,
                inclusive_seconds=sum(durations),
                exclusive_seconds=phase_exclusive,
                attribution=phase_exclusive / exclusive_total if exclusive_total else 0.0,
                p50_seconds=_percentile(durations, 0.50),
                p95_seconds=_percentile(durations, 0.95),
                error_count=error_count,
                timeout_count=timeout_count,
                cancelled_count=cancelled_count,
                error_rate=error_count / count,
                timeout_rate=timeout_count / count,
            )
        )

    trace_durations: list[float] = []
    for trace_id, trace_records in by_trace.items():
        roots = [
            record
            for record in trace_records
            if record.parent_span_id is None
            or (trace_id, record.parent_span_id) not in known_spans
        ]
        trace_ns = _union_ns(
            (record.started_monotonic_ns, record.ended_monotonic_ns) for record in roots
        )
        trace_durations.append(trace_ns / 1_000_000_000)

    return ObservabilitySummary(
        trace_count=len(by_trace),
        span_count=len(records),
        total_trace_seconds=sum(trace_durations),
        p50_trace_seconds=_percentile(trace_durations, 0.50),
        p95_trace_seconds=_percentile(trace_durations, 0.95),
        phases=tuple(phases),
    )
