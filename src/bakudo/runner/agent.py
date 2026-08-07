"""Assemble and run a thin Strands agent from an AgentSpec (spec section 7.2).

The Strands runtime is optional at import time so the rest of bakudo (and the
test suite) does not require it. ``build_and_run`` raises a clear error if the
runtime extras are missing and no offline driver is supplied.
"""

from __future__ import annotations

import json
import os
from collections.abc import Callable
from typing import Any

from ..agent_spec import AgentSpec
from ..bundle import TaskBundle
from ..strands_tools import BudgetExceeded, ToolContext, build_tool_callables
from .prompts import render_system_prompt, render_user_prompt

# An offline driver maps (system_prompt, user_prompt, tools) -> raw model text.
# Used for tests and for dry-runs without vLLM/Strands.
OfflineDriver = Callable[[str, str, dict[str, Callable[..., Any]]], str]


def build_model(spec: AgentSpec) -> Any:
    """Build a Strands model object from the spec's model config.

    The spec references a vLLM gateway via ``baseUrlRef`` (never an inline
    secret). We resolve the ref to a concrete base URL/key from the environment
    (host-side credential injection, spec section 19.4) and use Strands'
    OpenAI-compatible provider.
    """
    from strands.models.openai import OpenAIModel  # type: ignore

    from ..config import Settings

    base_url = _resolve_base_url(spec.model.base_url_ref)
    api_key = Settings.from_env().vllm_api_key or "not-needed"
    return OpenAIModel(
        client_args={"base_url": base_url, "api_key": api_key},
        model_id=spec.model.model_id,
        params={
            "temperature": spec.model.temperature,
            "max_tokens": spec.model.max_tokens,
        },
    )


def _resolve_base_url(base_url_ref: str | None) -> str:
    """Resolve a provider reference to a concrete base URL, failing loudly.

    Looks up ``BAKUDO_VLLM_<REF>`` (ref upper-cased, non-alphanumerics to
    ``_``), then falls back to ``VLLM_BASE_URL``. There is deliberately no
    hardcoded default: a run against a phantom gateway host is a debugging
    trap, so an unconfigured gateway is a startup error instead.
    """
    from ..config import Settings

    key = None
    if base_url_ref:
        key = (
            "BAKUDO_VLLM_"
            + "".join(c if c.isalnum() else "_" for c in base_url_ref).upper()
        )
        ref_url = os.environ.get(key)
        if ref_url:
            return ref_url

    default = Settings.from_env().vllm_base_url
    if default:
        return default
    raise RuntimeError(
        "No model gateway configured: set VLLM_BASE_URL"
        + (f" or {key}" if key else "")
        + " (or run offline with BAKUDO_OFFLINE=1)."
    )


def to_strands_tools(callables: dict[str, Callable[..., Any]]) -> list[Any]:
    """Adapt bakudo tool callables to Strands ``@tool`` functions."""
    from strands import tool  # type: ignore

    adapted = []
    for name, fn in callables.items():
        wrapped = tool(name=name)(fn)
        adapted.append(wrapped)
    return adapted


def build_and_run(
    spec: AgentSpec,
    bundle: TaskBundle,
    ctx: ToolContext,
    *,
    offline_driver: OfflineDriver | None = None,
) -> str:
    """Run the agent loop, returning the raw final model text.

    If ``offline_driver`` is provided (or ``BAKUDO_OFFLINE=1``), the Strands
    runtime is bypassed entirely — useful for tests and dry runs.
    """
    system_prompt = render_system_prompt(spec, bundle)
    user_prompt = render_user_prompt(bundle)
    tool_callables = build_tool_callables(spec, ctx)

    # Apply the run budget to the tool layer (wall-clock deadline + token cap).
    ctx.set_budget(
        timeout_seconds=bundle.budget.timeout_seconds,
        token_cap=bundle.budget.max_tokens,
    )

    if offline_driver is None and os.environ.get("BAKUDO_OFFLINE") == "1":
        _warn_offline_once()
        offline_driver = _default_offline_driver

    try:
        if offline_driver is not None:
            return offline_driver(system_prompt, user_prompt, tool_callables)

        from strands import Agent  # type: ignore

        model = build_model(spec)
        agent = Agent(
            model=model,
            system_prompt=system_prompt,
            tools=to_strands_tools(tool_callables),
        )
        ctx.model_calls += 1
        response = agent(user_prompt)
        _capture_usage(ctx, response)
        return str(response)
    except BudgetExceeded as exc:
        return json.dumps(
            {
                "status": "blocked",
                "summary": f"Run stopped: budget exceeded ({exc.reason}).",
                "blocked_reasons": [f"budget:{exc.reason}"],
            }
        )


_offline_warned = False


def _warn_offline_once() -> None:
    """Make the offline fallback visible instead of silently faking results."""
    global _offline_warned
    if _offline_warned:
        return
    _offline_warned = True
    import sys

    print(
        "[bakudo] BAKUDO_OFFLINE=1 — no model is invoked; runs return the "
        "offline driver's placeholder result.",
        file=sys.stderr,
    )


def _capture_usage(ctx: ToolContext, response: Any) -> None:
    """Best-effort token accounting from a Strands response (section 18.3)."""
    try:
        usage = response.metrics.accumulated_usage  # type: ignore[attr-defined]
        ctx.tokens_used += int(usage.get("totalTokens", 0))
    except Exception:  # noqa: BLE001 - usage shape varies; never fail the run on it
        pass


def _default_offline_driver(
    system_prompt: str, user_prompt: str, tools: dict[str, Callable[..., Any]]
) -> str:
    """A no-LLM driver that returns a minimal blocked result.

    It does not attempt the task; it exists so the full run pipeline (bundle
    render -> sandbox -> result capture -> eval) can be exercised end-to-end
    without a model. Real runs use Strands + vLLM.
    """
    return json.dumps(
        {
            "status": "blocked",
            "summary": "Offline driver: no model available to attempt the objective.",
            "blocked_reasons": ["offline_mode"],
        }
    )
