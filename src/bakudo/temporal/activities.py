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

    def _DEFN(fn=None, **_kwargs):  # type: ignore
        def wrap(f):
            return f

        return wrap(fn) if fn else wrap


@_DEFN(name="create_run")
def create_run(inp: AgentRunInput, workflow_id: str) -> dict:
    return _impl.create_run(inp, workflow_id)


@_DEFN(name="load_agent_spec")
def load_agent_spec(name: str) -> dict | None:
    return _impl.load_agent_spec(name)


@_DEFN(name="render_bundle")
def render_bundle(inp: AgentRunInput) -> dict:
    return _impl.render_bundle(inp)


@_DEFN(name="run_sandbox")
def run_sandbox(bundle: dict) -> dict:
    return _impl.run_sandbox(bundle)


@_DEFN(name="persist_run")
def persist_run(run_id: str, phase: str, payload: dict) -> None:
    _impl.persist_run(run_id, phase, payload)


@_DEFN(name="run_eval_suite")
def run_eval_suite(inp: EvalInput) -> dict:
    return _impl.run_eval_suite(inp)


@_DEFN(name="decide_promotion")
def decide_promotion(inp: PromotionInput) -> dict:
    return _impl.decide_promotion(inp)


@_DEFN(name="run_agent_evolution")
def run_agent_evolution(inp: EvolutionInput) -> dict:
    return _impl.run_agent_evolution(inp)


@_DEFN(name="compact_memories")
def compact_memories(inp: CompactionInput) -> dict:
    return _impl.compact_memories(inp)


@_DEFN(name="collect_signals")
def collect_signals(inp: ObserveInput) -> list[dict]:
    return _impl.collect_signals(inp)


ALL_ACTIVITIES: Sequence[Callable[..., Any]] = [
    create_run,
    load_agent_spec,
    render_bundle,
    run_sandbox,
    persist_run,
    run_eval_suite,
    decide_promotion,
    run_agent_evolution,
    compact_memories,
    collect_signals,
]
