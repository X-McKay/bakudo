"""Temporal activities: all non-deterministic external work (spec section 11.2).

Activities own LLM calls, abox invocations, DB reads/writes, eval grading, and
graph writes. They are registered on the worker and called from workflows.

The activity *implementations* are kept as plain functions in
:mod:`._impl` so they remain unit-testable without ``temporalio``; this module
applies the ``@activity.defn`` decorators when the SDK is present.
"""

from __future__ import annotations

from . import _impl
from .shared import AgentRunInput, EvalInput, PromotionInput

try:  # pragma: no cover - exercised only with the temporal extra installed
    from temporalio import activity

    _DEFN = activity.defn
except Exception:  # noqa: BLE001 - SDK optional

    def _DEFN(fn=None, **_kwargs):  # type: ignore
        def wrap(f):
            return f

        return wrap(fn) if fn else wrap


@_DEFN(name="create_run")
async def create_run(inp: AgentRunInput, workflow_id: str) -> dict:
    return _impl.create_run(inp, workflow_id)


@_DEFN(name="render_bundle")
async def render_bundle(inp: AgentRunInput) -> dict:
    return _impl.render_bundle(inp)


@_DEFN(name="run_sandbox")
async def run_sandbox(bundle: dict) -> dict:
    return _impl.run_sandbox(bundle)


@_DEFN(name="persist_run")
async def persist_run(run_id: str, phase: str, payload: dict) -> None:
    _impl.persist_run(run_id, phase, payload)


@_DEFN(name="run_eval_suite")
async def run_eval_suite(inp: EvalInput) -> dict:
    return _impl.run_eval_suite(inp)


@_DEFN(name="decide_promotion")
async def decide_promotion(inp: PromotionInput) -> dict:
    return _impl.decide_promotion(inp)


ALL_ACTIVITIES = [
    create_run,
    render_bundle,
    run_sandbox,
    persist_run,
    run_eval_suite,
    decide_promotion,
]
