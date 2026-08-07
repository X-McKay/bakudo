"""Admission control for concurrent sandbox executions (§3 of the roadmap).

MicroVM boots collapse under unbounded fan-out (the reference measurement in
prime-agent's boot-gate: 256 concurrent boots drop to ~28% success at N=200;
cores*4 holds 100%). Everything that launches a sandbox — the Temporal
activity layer and the corpus harness — acquires this process-wide gate
first, so parallel attempt fan-outs and corpus runs queue instead of
stampeding.

The width defaults to ``min(16, max(2, cores * 2))`` and can be overridden
(clamped to [1, 64]) with ``BAKUDO_SANDBOX_CONCURRENCY``. The semaphore is
resolved lazily on first acquisition so the env override is honoured whenever
it is set before the first run; tests reset with :func:`reset_gate`.
"""

from __future__ import annotations

import os
import threading
from contextlib import contextmanager

from ..config import Settings

_MAX_WIDTH = 64

_lock = threading.Lock()
_gate: threading.BoundedSemaphore | None = None
_width: int | None = None


def default_width() -> int:
    return min(16, max(2, (os.cpu_count() or 4) * 2))


def gate_width() -> int:
    """The resolved admission width (for observability/tests)."""
    _ensure()
    assert _width is not None
    return _width


def _ensure() -> None:
    global _gate, _width
    with _lock:
        if _gate is not None:
            return
        configured = Settings.from_env().sandbox_concurrency
        width = configured if configured is not None else default_width()
        _width = max(1, min(_MAX_WIDTH, width))
        _gate = threading.BoundedSemaphore(_width)


def reset_gate() -> None:
    """Forget the resolved gate (tests / re-configuration)."""
    global _gate, _width
    with _lock:
        _gate = None
        _width = None


@contextmanager
def sandbox_slot():
    """Hold one sandbox admission slot for the duration of a run."""
    _ensure()
    assert _gate is not None
    _gate.acquire()
    try:
        yield
    finally:
        _gate.release()
