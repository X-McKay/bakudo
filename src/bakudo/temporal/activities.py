"""Temporal activities: all non-deterministic external work (spec section 11.2).

Activities own LLM calls, abox invocations, DB reads/writes, eval grading, and
graph writes. They are registered on the worker and called from workflows.

Every activity is a *sync* ``def`` (TMP-1): the implementations block on
subprocess sandbox runs, sync psycopg, and httpx, so they must run on the
worker's ``activity_executor`` thread pool — an ``async def`` activity would
freeze the event loop shared by both task queues.

The activity *implementations* are kept as plain functions in
:mod:`._impl` so they remain unit-testable without ``temporalio``; this module
applies the ``@activity.defn`` decorators when the SDK is present.
"""

from __future__ import annotations

import contextvars
import threading
from collections.abc import Callable, Sequence
from typing import Any

from . import _impl
from .shared import (
    AgentRunInput,
    CompactionInput,
    EvalInput,
    EvolutionInput,
    ObserveInput,
    PromotionInput,
)

try:  # pragma: no cover - exercised only with the temporal extra installed
    from temporalio import activity

    _DEFN = activity.defn
except Exception:  # noqa: BLE001 - SDK optional
    activity = None  # type: ignore[assignment]

    def _DEFN(fn=None, **_kwargs):  # type: ignore
        def wrap(f):
            return f

        return wrap(fn) if fn else wrap


# How often run_sandbox heartbeats while the sandbox subprocess runs (TMP-12).
# Module-level so tests can shrink it; keep it well under the workflow's
# heartbeat_timeout.
_HEARTBEAT_INTERVAL_SECONDS = 30.0


def _in_activity() -> bool:
    try:
        return activity is not None and activity.in_activity()
    except Exception:  # noqa: BLE001 - context probe must never raise
        return False


@_DEFN(name="create_run")
def create_run(inp: AgentRunInput, workflow_id: str) -> dict:
    return _impl.create_run(inp, workflow_id)


@_DEFN(name="load_agent_spec")
def load_agent_spec(name: str, run_id: str | None = None) -> dict | None:
    return _impl.load_agent_spec(name, run_id)


@_DEFN(name="render_bundle")
def render_bundle(inp: AgentRunInput) -> dict:
    return _impl.render_bundle(inp)


@_DEFN(name="run_sandbox")
def run_sandbox(bundle: dict) -> dict:
    """Run the sandbox, heartbeating from a side thread while it blocks (TMP-12).

    The sandbox call can block for hours; heartbeats let the server detect a
    crashed worker via ``heartbeat_timeout`` in minutes instead of waiting out
    the 2h start-to-close. The heartbeat thread runs inside a copy of the
    activity's contextvars so ``activity.heartbeat()`` resolves the context.
    Outside an activity (unit tests, tooling) no thread is started.
    """
    stop = threading.Event()
    # Set when Temporal cancels the activity; threaded into the sandbox so the
    # abox subprocess is actually terminated (SEC-5) — cancelling the activity
    # alone cannot interrupt the blocking subprocess, so a cancelled agent would
    # otherwise keep running and spending until the sandbox timeout.
    cancel_event = threading.Event()
    beat_thread: threading.Thread | None = None
    if _in_activity():
        ctx = contextvars.copy_context()

        def _beat() -> None:
            while not stop.wait(_HEARTBEAT_INTERVAL_SECONDS):
                activity.heartbeat()
                if activity.is_cancelled():
                    cancel_event.set()
                    return

        beat_thread = threading.Thread(
            target=lambda: ctx.run(_beat),
            name="run-sandbox-heartbeat",
            daemon=True,
        )
        beat_thread.start()
    try:
        return _impl.run_sandbox(bundle, cancel_event=cancel_event)
    finally:
        stop.set()
        if beat_thread is not None:
            beat_thread.join(timeout=2)


@_DEFN(name="measure_winner_bench")
def measure_winner_bench(diff: str, bench_command: str, repo: str) -> dict:
    return _impl.measure_winner_bench(diff, bench_command, repo)


@_DEFN(name="persist_run")
def persist_run(run_id: str, phase: str, payload: dict) -> None:
    _impl.persist_run(run_id, phase, payload)


@_DEFN(name="run_eval_suite")
def run_eval_suite(inp: EvalInput) -> dict:
    return _impl.run_eval_suite(inp)


@_DEFN(name="decide_promotion")
def decide_promotion(inp: PromotionInput) -> dict:
    return _impl.decide_promotion(inp)


@_DEFN(name="check_canary_graduation")
def check_canary_graduation(name: str) -> dict:
    return _impl.check_canary_graduation(name)


@_DEFN(name="run_agent_evolution")
def run_agent_evolution(inp: EvolutionInput) -> dict:
    return _impl.run_agent_evolution(inp)


@_DEFN(name="compact_memories")
def compact_memories(inp: CompactionInput) -> dict:
    return _impl.compact_memories(inp)


@_DEFN(name="collect_signals")
def collect_signals(inp: ObserveInput) -> list[dict]:
    return _impl.collect_signals(inp)


@_DEFN(name="reconcile_runs")
def reconcile_runs(run_ids: list[str]) -> list[str]:
    return _impl.reconcile_runs(run_ids)


ALL_ACTIVITIES: Sequence[Callable[..., Any]] = [
    create_run,
    load_agent_spec,
    render_bundle,
    run_sandbox,
    measure_winner_bench,
    persist_run,
    run_eval_suite,
    decide_promotion,
    check_canary_graduation,
    run_agent_evolution,
    compact_memories,
    collect_signals,
    reconcile_runs,
]
