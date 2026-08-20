"""Vendor-neutral, fail-open phase span recording."""

from __future__ import annotations

import asyncio
import time
import uuid
from collections.abc import Callable, Iterator, Mapping
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field, replace
from enum import Enum
from threading import Lock
from types import MappingProxyType
from typing import Protocol

from bakudo.observability.policy import (
    DEFAULT_ATTRIBUTE_POLICY,
    AttributeKey,
    AttributePolicy,
    AttributeValue,
    SpanAttribute,
)


class SpanName(str, Enum):
    """Stable names for Bakudo control-plane latency boundaries."""

    RUN = "bakudo.run"
    QUEUE_WAIT = "bakudo.queue.wait"
    BUNDLE_RENDER = "bakudo.bundle.render"
    SANDBOX_PREPARE = "bakudo.sandbox.prepare"
    MODEL_FIRST_TOKEN = "bakudo.model.first_token"
    MODEL_GENERATE = "bakudo.model.generate"
    TOOL_EXECUTE = "bakudo.tool.execute"
    REPORT_EXTRACT = "bakudo.report.extract"
    VERIFIER_RUN = "bakudo.verifier.run"
    PERFORMANCE_MEASURE = "bakudo.performance.measure"
    STATISTICS_ANALYZE = "bakudo.statistics.analyze"
    LEDGER_PERSIST = "bakudo.ledger.persist"


class SpanStatus(str, Enum):
    """Terminal status recorded without raw exception content."""

    OK = "ok"
    ERROR = "error"
    CANCELLED = "cancelled"
    TIMEOUT = "timeout"


@dataclass(frozen=True)
class SpanContext:
    """Small propagation token for nested or explicitly linked spans."""

    trace_id: str
    span_id: str


@dataclass(frozen=True)
class SpanRecord:
    """Completed phase span emitted to a telemetry adapter."""

    name: SpanName
    context: SpanContext
    parent_span_id: str | None
    started_monotonic_ns: int
    ended_monotonic_ns: int
    status: SpanStatus
    attributes: Mapping[str, AttributeValue] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if self.started_monotonic_ns < 0:
            raise ValueError("started_monotonic_ns must be non-negative")
        if self.ended_monotonic_ns < self.started_monotonic_ns:
            raise ValueError("ended_monotonic_ns must not precede start")
        object.__setattr__(self, "attributes", MappingProxyType(dict(self.attributes)))

    @property
    def duration_seconds(self) -> float:
        return (self.ended_monotonic_ns - self.started_monotonic_ns) / 1_000_000_000


class SpanSink(Protocol):
    """Minimal boundary implemented by telemetry and in-memory adapters."""

    def emit(self, record: SpanRecord) -> None: ...


class NoOpSpanSink:
    """Dependency-free default used when telemetry is disabled."""

    __slots__ = ()

    def emit(self, record: SpanRecord) -> None:
        del record


NOOP_SPAN_SINK: SpanSink = NoOpSpanSink()


class FakeSpanSink:
    """Bounded, thread-safe recorder for tests and local diagnostics."""

    def __init__(
        self,
        *,
        max_records: int = 10_000,
        policy: AttributePolicy = DEFAULT_ATTRIBUTE_POLICY,
    ) -> None:
        if max_records <= 0:
            raise ValueError("max_records must be positive")
        self._max_records = max_records
        self._policy = policy
        self._records: list[SpanRecord] = []
        self._dropped_count = 0
        self._lock = Lock()

    def emit(self, record: SpanRecord) -> None:
        safe_record = replace(record, attributes=self._policy.sanitize(record.attributes))
        with self._lock:
            if len(self._records) >= self._max_records:
                self._dropped_count += 1
                return
            self._records.append(safe_record)

    @property
    def records(self) -> tuple[SpanRecord, ...]:
        with self._lock:
            return tuple(self._records)

    @property
    def dropped_count(self) -> int:
        with self._lock:
            return self._dropped_count

    def clear(self) -> None:
        with self._lock:
            self._records.clear()
            self._dropped_count = 0


_CURRENT_SPAN: ContextVar[SpanContext | None] = ContextVar("bakudo_current_span", default=None)


def current_span_context() -> SpanContext | None:
    """Return the active span context for explicit async/process propagation."""

    return _CURRENT_SPAN.get()


@dataclass
class ActiveSpan:
    """Mutable state exposed only while a :func:`phase_span` is active."""

    context: SpanContext
    _attributes: dict[AttributeKey, object]
    _status: SpanStatus = SpanStatus.OK

    def set_attribute(self, key: AttributeKey, value: object) -> None:
        self._attributes[key] = value

    def set_status(self, status: SpanStatus) -> None:
        self._status = status


def _new_trace_id() -> str:
    return uuid.uuid4().hex


def _new_span_id() -> str:
    return uuid.uuid4().hex[:16]


def _exception_status(error: BaseException) -> SpanStatus:
    if isinstance(error, asyncio.CancelledError):
        return SpanStatus.CANCELLED
    if isinstance(error, TimeoutError):
        return SpanStatus.TIMEOUT
    return SpanStatus.ERROR


@contextmanager
def phase_span(
    name: SpanName,
    *,
    sink: SpanSink = NOOP_SPAN_SINK,
    attributes: Mapping[AttributeKey, object] | None = None,
    parent: SpanContext | None = None,
    clock: Callable[[], int] = time.monotonic_ns,
) -> Iterator[ActiveSpan]:
    """Record one monotonic, safely attributed phase without changing behavior.

    Sink/export errors are intentionally swallowed.  Exceptions from the
    instrumented operation are recorded as a bounded status and exception type,
    then re-raised unchanged.  A supplied ``parent`` supports propagation
    across an async or worker boundary; otherwise the current context is used.
    """

    parent_context = parent if parent is not None else _CURRENT_SPAN.get()
    context = SpanContext(
        trace_id=parent_context.trace_id if parent_context else _new_trace_id(),
        span_id=_new_span_id(),
    )
    active = ActiveSpan(context=context, _attributes=dict(attributes or {}))
    token = _CURRENT_SPAN.set(context)
    started = clock()
    try:
        yield active
    except BaseException as error:
        active.set_status(_exception_status(error))
        active.set_attribute(SpanAttribute.ERROR_TYPE, type(error).__name__)
        raise
    finally:
        ended = max(started, clock())
        _CURRENT_SPAN.reset(token)
        try:
            record = SpanRecord(
                name=name,
                context=context,
                parent_span_id=parent_context.span_id if parent_context else None,
                started_monotonic_ns=started,
                ended_monotonic_ns=ended,
                status=active._status,
                attributes=DEFAULT_ATTRIBUTE_POLICY.sanitize(active._attributes),
            )
            sink.emit(record)
        except Exception:
            # Telemetry is diagnostic; adapter and policy failures cannot alter
            # the operation being observed.
            pass
