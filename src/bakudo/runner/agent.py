"""Assemble and run a thin Strands agent from an AgentSpec (spec section 7.2).

The Strands runtime is optional at import time so the rest of bakudo (and the
test suite) does not require it. ``build_and_run`` raises a clear error if the
runtime extras are missing and no offline driver is supplied.
"""

from __future__ import annotations

import functools
import inspect
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

# The in-guest deadline sits below the abox --timeout so a graceful
# "blocked: budget" result always beats the VM kill (review finding ABOX-16).
GUEST_DEADLINE_HEADROOM_SECONDS = 30


class TokenAccounting:
    """Per-model-call token accounting + budget enforcement (finding API-3).

    Strands accumulates usage on ``agent.event_loop_metrics.accumulated_usage``
    across the internal tool-use loop; this hook delta-accounts it into the
    :class:`ToolContext` after *every* model call and re-checks the budget, so
    a token cap (and the wall-clock deadline) can trip mid-run instead of only
    after the loop ends. Registered via the Strands hooks API when the runtime
    is present; ``on_model_call`` is runtime-agnostic and unit-testable.
    """

    def __init__(self, ctx: ToolContext) -> None:
        self._ctx = ctx
        self._last_total = 0

    def on_model_call(self, event: Any) -> None:
        self._ctx.model_calls += 1
        try:
            usage = event.agent.event_loop_metrics.accumulated_usage
            total = int(usage.get("totalTokens", 0))
        except Exception:  # noqa: BLE001 - usage shape varies across providers
            total = self._last_total
        if total > self._last_total:
            self._ctx.tokens_used += total - self._last_total
            self._last_total = total
        self._ctx.check_budget()

    def register_hooks(self, registry: Any, **_: Any) -> None:
        """Strands ``HookProvider`` protocol entrypoint."""
        from strands.hooks import AfterModelCallEvent  # type: ignore

        registry.add_callback(AfterModelCallEvent, self.on_model_call)


def build_model(spec: AgentSpec) -> Any:
    """Build a Strands model object from the spec's model config.

    The spec references a vLLM gateway via ``baseUrlRef`` (never an inline
    secret). We resolve the ref to a concrete base URL/key from the environment
    (host-side credential injection, spec section 19.4) and use Strands'
    OpenAI-compatible provider.
    """
    from strands.models.openai import OpenAIModel  # type: ignore

    base_url = _resolve_base_url(spec.model.base_url_ref)
    api_key = os.environ.get("VLLM_API_KEY", "not-needed")
    return OpenAIModel(
        client_args={"base_url": base_url, "api_key": api_key},
        model_id=spec.model.model_id,
        params={
            "temperature": spec.model.temperature,
            "max_tokens": spec.model.max_tokens,
        },
    )


def _resolve_base_url(base_url_ref: str | None) -> str:
    """Resolve a provider reference to a concrete base URL.

    Looks up ``BAKUDO_VLLM_<REF>`` (ref upper-cased, non-alphanumerics to ``_``),
    then falls back to ``VLLM_BASE_URL``, then the internal gateway default.
    """
    default = os.environ.get("VLLM_BASE_URL", "https://vllm-gateway.internal/v1")
    if not base_url_ref:
        return default
    key = "BAKUDO_VLLM_" + "".join(c if c.isalnum() else "_" for c in base_url_ref).upper()
    return os.environ.get(key, default)


def _as_named_callable(name: str, fn: Callable[..., Any]) -> Callable[..., Any]:
    """Present a ToolContext-bound ``functools.partial`` as a plain function.

    Strands' ``@tool`` requires a real function (``__name__``/``__doc__``/
    inspectable signature) and derives the model-facing input schema from it,
    so the partial's already-bound leading parameters (the ToolContext) must
    be stripped from the visible signature.
    """
    if not isinstance(fn, functools.partial):
        return fn

    inner = fn.func
    sig = inspect.signature(inner)
    params = list(sig.parameters.values())[len(fn.args):]
    params = [p for p in params if p.name not in fn.keywords]

    def wrapper(*args: Any, **kwargs: Any) -> Any:
        return fn(*args, **kwargs)

    wrapper.__name__ = name.replace("-", "_")
    wrapper.__qualname__ = wrapper.__name__
    wrapper.__doc__ = inner.__doc__
    wrapper.__signature__ = sig.replace(parameters=params)  # type: ignore[attr-defined]
    wrapper.__annotations__ = {
        p.name: p.annotation for p in params if p.annotation is not inspect.Parameter.empty
    }
    if sig.return_annotation is not inspect.Signature.empty:
        wrapper.__annotations__["return"] = sig.return_annotation
    return wrapper


def to_strands_tools(callables: dict[str, Callable[..., Any]]) -> list[Any]:
    """Adapt bakudo tool callables to Strands ``@tool`` functions."""
    from strands import tool  # type: ignore

    adapted = []
    for name, fn in callables.items():
        wrapped = tool(name=name)(_as_named_callable(name, fn))
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

    # Apply the run budget to the tool layer (wall-clock deadline + token cap),
    # keeping headroom below the abox --timeout so the graceful blocked result
    # wins the race against the VM kill (ABOX-16).
    ctx.set_budget(
        timeout_seconds=max(
            1, bundle.budget.timeout_seconds - GUEST_DEADLINE_HEADROOM_SECONDS
        ),
        token_cap=bundle.budget.max_tokens,
    )

    if offline_driver is None and os.environ.get("BAKUDO_OFFLINE") == "1":
        offline_driver = _default_offline_driver

    try:
        if offline_driver is not None:
            return offline_driver(system_prompt, user_prompt, tool_callables)

        from strands import Agent  # type: ignore

        model = build_model(spec)
        accounting = TokenAccounting(ctx)
        agent = Agent(
            model=model,
            system_prompt=system_prompt,
            tools=to_strands_tools(tool_callables),
            hooks=[accounting],
        )
        response = agent(user_prompt)
        if ctx.tokens_used == 0:
            # Fallback when the hooks API yielded no usage (provider variance).
            _capture_usage(ctx, response)
        return str(response)
    except BudgetExceeded as exc:
        return _blocked_by_budget(exc)
    except Exception as exc:
        # The Strands event loop may wrap a hook-raised BudgetExceeded.
        budget_exc = _find_budget_exceeded(exc)
        if budget_exc is not None:
            return _blocked_by_budget(budget_exc)
        raise


def _blocked_by_budget(exc: BudgetExceeded) -> str:
    return json.dumps(
        {
            "status": "blocked",
            "summary": f"Run stopped: budget exceeded ({exc.reason}).",
            "blocked_reasons": [f"budget:{exc.reason}"],
        }
    )


def _find_budget_exceeded(exc: BaseException | None) -> BudgetExceeded | None:
    """Walk the exception chain looking for a wrapped :class:`BudgetExceeded`."""
    seen: set[int] = set()
    while exc is not None and id(exc) not in seen:
        seen.add(id(exc))
        if isinstance(exc, BudgetExceeded):
            return exc
        exc = exc.__cause__ or exc.__context__
    return None


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
