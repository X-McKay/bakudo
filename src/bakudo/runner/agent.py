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
import sys
from collections.abc import Callable
from typing import Any

from ..agent_spec import AgentSpec
from ..bundle import TaskBundle
from ..strands_tools import LoopHalt, ToolContext, build_tool_callables
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
    params: dict[str, Any] = {
        "temperature": spec.model.temperature,
        "max_tokens": spec.model.max_tokens,
    }
    if spec.model.enable_thinking is not None:
        # Hybrid reasoning models (Qwen): per-request thinking toggle. The
        # openai SDK forwards extra_body verbatim; vLLM applies it via
        # chat_template_kwargs (verified against the live deployment).
        params["extra_body"] = {
            "chat_template_kwargs": {"enable_thinking": spec.model.enable_thinking}
        }
    return OpenAIModel(
        client_args={"base_url": base_url, "api_key": api_key},
        model_id=spec.model.model_id,
        params=params,
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

    # Apply the run budget to the tool layer (wall-clock deadline + token cap
    # + tool-call ceiling), keeping headroom below the abox --timeout so the
    # graceful blocked result wins the race against the VM kill (ABOX-16).
    ctx.set_budget(
        timeout_seconds=max(
            1, bundle.budget.timeout_seconds - GUEST_DEADLINE_HEADROOM_SECONDS
        ),
        token_cap=bundle.budget.max_tokens,
        tool_call_ceiling=bundle.budget.max_tool_calls,
    )

    if offline_driver is None and os.environ.get("BAKUDO_OFFLINE") == "1":
        offline_driver = _default_offline_driver

    if offline_driver is not None:
        # No strands agent exists offline, so there is no report phase to run;
        # a halt maps straight to its canned blocked result.
        try:
            return offline_driver(system_prompt, user_prompt, tool_callables)
        except LoopHalt as offline_halt:
            return _halt_fallback(offline_halt)

    from strands import Agent  # type: ignore

    model = build_model(spec)
    accounting = TokenAccounting(ctx)
    agent = Agent(
        model=model,
        system_prompt=system_prompt,
        tools=to_strands_tools(tool_callables),
        hooks=[accounting],
    )

    # Run the loop to *some* ending — clean finish, LoopHalt (budget/tool-call
    # ceiling/denial breaker), or a maxTokens clip — then fall through to the
    # one unconditional report phase. The report is the deliverable; it must
    # never again be a side effect of how the loop happened to end (issue #27).
    halt: LoopHalt | None = None
    try:
        response = agent(user_prompt)
        if ctx.tokens_used == 0:
            # Fallback when the hooks API yielded no usage (provider variance).
            _capture_usage(ctx, response)
        fallback = str(response)
    except LoopHalt as exc:
        halt = exc
        fallback = _halt_fallback(halt)
    except Exception as exc:
        # The Strands event loop may wrap a hook-raised LoopHalt.
        halt = _find_loop_halt(exc)
        if halt is not None:
            fallback = _halt_fallback(halt)
        else:
            partial = _partial_text_on_max_tokens(exc, agent)
            if partial is None:
                raise
            # Even a clipped conversation usually holds enough for a report.
            fallback = partial

    return _report_phase(agent, ctx, halt=halt, fallback=fallback)


def _report_phase(agent: Any, ctx: ToolContext, *, halt: LoopHalt | None, fallback: str) -> str:
    """The unconditional final phase: extract the run report (issue #27).

    Budget enforcement is disarmed first so the one bounded extraction call
    cannot be killed by the very budget that ended the loop. A halted run's
    report is coerced to ``blocked`` with the halt reason appended — the model
    reports what it did, the runner reports how the run ended. Any extraction
    failure falls back to the ending-specific text, which ``normalize_result``
    best-effort parses as before.
    """
    ctx.begin_report_phase()
    report = _extract_report(agent, fallback=None, halt=halt)
    if report is None:
        return fallback
    if halt is not None:
        report["status"] = "blocked"
        reasons = [str(r) for r in report.get("blocked_reasons") or []]
        if halt.blocked_reason not in reasons:
            reasons.append(halt.blocked_reason)
        report["blocked_reasons"] = reasons
    return json.dumps(report)


def _extract_report(
    agent: Any, fallback: Any = None, halt: LoopHalt | None = None
) -> dict[str, Any] | None:
    """Extract the run report via strands structured output, from history.

    Schema-enforced tool-use makes the result contract non-negotiable (a
    scout narrating approaches in prose while leaving ``proposed_followups``
    empty was observed live). Returns the report dict, or ``fallback`` when
    extraction fails.
    """
    from .result import AgentReport

    prompt = _EXTRACTION_PROMPT if halt is None else _halted_extraction_prompt(halt)
    try:
        # The instructions matter: without them this model fills the scalar
        # fields and leaves arrays empty (verified live against the vLLM
        # deployment — two approaches in prose, followups []).
        report = agent.structured_output(AgentReport, prompt)
        return report.model_dump(mode="json")
    except Exception as exc:  # noqa: BLE001 - extraction is an upgrade, not a gate
        # Guest stderr is collected into AboxOutcome — a silent fallback here
        # cost a live diagnosis (the strands-1.45 tools:[] 400 was invisible).
        print(
            f"[agent-runner] report extraction failed, using fallback: "
            f"{type(exc).__name__}: {exc}",
            file=sys.stderr,
        )
        return fallback


_EXTRACTION_PROMPT = (
    "Fill out the run report for YOUR work above. Every distinct approach/"
    "hypothesis you identified or proposed MUST be one self-contained entry in "
    "proposed_followups (what to change, expected effect, how to verify) — an "
    "approach mentioned only in prose does not exist. Leave proposed_followups "
    "empty ONLY if you genuinely found nothing worth doing. Record every test "
    "command you executed as a tests_run entry ({command, status}) — the task "
    "gate needs passing-test evidence, and a test run not recorded there does "
    "not count."
)


def _halted_extraction_prompt(halt: LoopHalt) -> str:
    return (
        f"The run was force-stopped before completion ({halt}). You cannot run "
        "any more tools. Report only work you already did. " + _EXTRACTION_PROMPT
    )


def _partial_text_on_max_tokens(exc: Exception, agent: Any) -> str | None:
    """Salvage the partial response when generation hit ``maxTokens``.

    Strands raises ``MaxTokensReachedException`` after appending the partial
    assistant message to the conversation history; a truncated review/summary
    that the result normalizer can parse beats failing the whole run (observed
    live: the critic's thinking + verdict overran the cap mid-eval).
    """
    if type(exc).__name__ != "MaxTokensReachedException":
        return None
    for message in reversed(getattr(agent, "messages", []) or []):
        if message.get("role") != "assistant":
            continue
        content = message.get("content", [])
        texts = [b["text"] for b in content if isinstance(b, dict) and "text" in b]
        if texts:
            return "\n".join(texts)
    return None


def _halt_fallback(halt: LoopHalt) -> str:
    return json.dumps(
        {
            "status": "blocked",
            "summary": f"Run stopped: {halt}",
            "blocked_reasons": [halt.blocked_reason],
        }
    )


def _find_loop_halt(exc: BaseException | None) -> LoopHalt | None:
    """Walk the exception chain looking for a wrapped :class:`LoopHalt`."""
    seen: set[int] = set()
    while exc is not None and id(exc) not in seen:
        seen.add(id(exc))
        if isinstance(exc, LoopHalt):
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
