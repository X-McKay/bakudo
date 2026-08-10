"""Temporal activities: all non-deterministic external work (spec section 11.2).

Activities own LLM calls, abox invocations, DB reads/writes, eval grading, and
graph writes. They are registered on the worker and called from workflows.

The activity *implementations* are kept as plain functions in
:mod:`._impl` so they remain unit-testable without ``temporalio``; this module
applies the ``@activity.defn`` decorators when the SDK is present.

Every activity here is **synchronous** (plain ``def``): the implementations
block on subprocesses (abox microVMs) and DB drivers, and an ``async def``
activity would run that blocking work on the worker's event loop, stalling
every other workflow task and heartbeat on the worker. Sync activities are
dispatched to the worker's ``activity_executor`` thread pool instead (see
:mod:`.worker`). Long-running activities additionally heartbeat while their
implementation runs, so a lost worker is detected within the heartbeat
timeout rather than the multi-hour activity timeout.
"""

from __future__ import annotations

import concurrent.futures
from collections.abc import Callable, Sequence
from typing import Any, TypeVar

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


# How often long-running activities heartbeat. Must be comfortably below the
# heartbeat_timeout the workflows set on their activity options.
HEARTBEAT_INTERVAL_SECONDS = 30.0

_T = TypeVar("_T")


def _heartbeat() -> None:
    """Record an activity heartbeat; a no-op outside an activity context."""
    if activity is None:  # pragma: no cover - SDK missing
        return
    try:
        if activity.in_activity():
            activity.heartbeat()
    except Exception:  # noqa: BLE001 - heartbeating must never fail the run
        pass


def _with_heartbeat(fn: Callable[..., _T], *args: Any) -> _T:
    """Run a blocking implementation in a helper thread, heartbeating.

    The activity thread stays responsive to the SDK (heartbeats, cancellation
    delivery) while the implementation blocks on a subprocess or DB call.
    """
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
        future = pool.submit(fn, *args)
        while True:
            try:
                return future.result(timeout=HEARTBEAT_INTERVAL_SECONDS)
            except TimeoutError:
                _heartbeat()


@_DEFN(name="create_run")
def create_run(inp: AgentRunInput, workflow_id: str) -> dict:
    return _impl.create_run(inp, workflow_id)


@_DEFN(name="render_bundle")
def render_bundle(inp: AgentRunInput) -> dict:
    return _impl.render_bundle(inp)


@_DEFN(name="resolve_agent_spec")
def resolve_agent_spec(
    agent: str | None, objective_type: str, routing_key: str = ""
) -> dict | None:
    return _impl.resolve_agent_spec(agent, objective_type, routing_key)


@_DEFN(name="observe_canary_run")
def observe_canary_run(run_id: str) -> dict | None:
    return _impl.observe_canary_run(run_id)


@_DEFN(name="run_sandbox")
def run_sandbox(bundle: dict) -> dict:
    return _with_heartbeat(_impl.run_sandbox, bundle)


@_DEFN(name="persist_run")
def persist_run(run_id: str, phase: str, payload: dict) -> None:
    _impl.persist_run(run_id, phase, payload)


@_DEFN(name="run_eval_suite")
def run_eval_suite(inp: EvalInput) -> dict:
    return _with_heartbeat(_impl.run_eval_suite, inp)


@_DEFN(name="decide_promotion")
def decide_promotion(inp: PromotionInput) -> dict:
    return _impl.decide_promotion(inp)


@_DEFN(name="run_agent_evolution")
def run_agent_evolution(inp: EvolutionInput) -> dict:
    return _with_heartbeat(_impl.run_agent_evolution, inp)


@_DEFN(name="compact_memories")
def compact_memories(inp: CompactionInput) -> dict:
    return _impl.compact_memories(inp)


@_DEFN(name="collect_signals")
def collect_signals(inp: ObserveInput) -> list[dict]:
    return _impl.collect_signals(inp)


ALL_ACTIVITIES: Sequence[Callable[..., Any]] = [
    create_run,
    render_bundle,
    resolve_agent_spec,
    observe_canary_run,
    run_sandbox,
    persist_run,
    run_eval_suite,
    decide_promotion,
    run_agent_evolution,
    compact_memories,
    collect_signals,
]
