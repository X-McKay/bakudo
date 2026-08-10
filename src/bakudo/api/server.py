"""FastAPI control API (spec section 25).

In v0.1 the API drives an in-process :class:`MetaAgentTools` so the system is
demonstrable without a Temporal cluster. In production the same routes signal
the durable :class:`MetaAgentWorkflow` via :mod:`bakudo.temporal.client`.
"""

from __future__ import annotations

import logging
import os
import secrets
from collections.abc import Callable
from typing import Any

from pydantic import BaseModel

from ..control import MetaAgentTools
from ..curriculum import QueueName

logger = logging.getLogger(__name__)


# Request models live at module scope: under `from __future__ import
# annotations`, FastAPI resolves the (stringified) handler annotations against
# module globals, so function-local models silently degrade to query params.
class ObjectiveIn(BaseModel):
    repo: str
    type: str
    title: str
    description: str = ""
    acceptanceCriteria: list[str] = []
    constraints: dict[str, Any] = {}


class OptimizeIn(BaseModel):
    repo: str
    title: str
    description: str = ""
    targetPaths: list[str] = []
    benchCommand: str | None = None
    maxFilesChanged: int | None = None
    maxRounds: int = 2
    maxApproaches: int = 3


class RunIn(BaseModel):
    objective_id: str
    agent: str


class PromotionResolutionIn(BaseModel):
    """Body of POST /promotions/{promotion_id}/approve|reject (spec §25.3).

    Deliberately identity-and-commentary only: scorecards and mutation kinds
    are read from the LEDGER's stored decision, never from the request
    (OPT-7/API-7). Unknown extra fields are ignored by pydantic.
    """

    approved_by: str
    comment: str | None = None


def _resolve_sandbox() -> Callable[..., Any]:
    """Resolve the run sandbox with the same fail-closed policy as the
    Temporal activity layer (:meth:`bakudo.temporal._impl.Deps.sandbox_fn`,
    importable without the ``temporal`` extra): ``BAKUDO_SANDBOX`` must be
    ``abox`` or ``local``, ``local`` additionally requires ``BAKUDO_ENV=dev``,
    and unset raises instead of silently executing on the host (OPT-10).
    """
    from ..temporal._impl import Deps

    return Deps(memory=None).sandbox_fn()


def _register_repo_agent_specs(tools: MetaAgentTools) -> None:
    """Register the seed agents (``agents/*.yaml``) at startup with the same
    loader the CLI uses, so ``POST /runs`` resolves them by name and
    'Unknown agent' only means a genuinely unknown name (API-8).

    Resolved via :func:`bakudo.paths.agents_dir`, which works from both a
    source checkout and a wheel install (API-12).
    """
    from ..agent_spec import load_spec_file
    from ..paths import agents_dir

    for spec_path in sorted(agents_dir().glob("*.yaml")):
        tools.register_agent_spec(load_spec_file(spec_path))


def build_app(tools: MetaAgentTools | None = None) -> Any:
    """Build the FastAPI app. Requires the ``api`` extra (fastapi, uvicorn)."""
    from fastapi import Depends, FastAPI, Header, HTTPException

    tools = tools or MetaAgentTools()
    _register_repo_agent_specs(tools)

    # Bearer-token auth on every route (API-1). When BAKUDO_API_TOKEN is unset,
    # auth is disabled (dev only) — warned once here; set it in any shared
    # environment.
    api_token = os.environ.get("BAKUDO_API_TOKEN")
    if not api_token:
        logger.warning("API auth disabled: BAKUDO_API_TOKEN not set")

    def require_auth(authorization: str | None = Header(default=None)) -> None:
        if not api_token:
            return
        supplied = (authorization or "").encode("utf-8")
        expected = f"Bearer {api_token}".encode()
        if not secrets.compare_digest(supplied, expected):
            raise HTTPException(status_code=401, detail="invalid or missing bearer token")

    from fastapi.openapi.docs import get_redoc_html, get_swagger_ui_html
    from fastapi.responses import HTMLResponse

    # App-level dependency: every route, read and write, requires the token
    # when one is configured. FastAPI's default /openapi.json//docs//redoc
    # endpoints are NOT path operations, so they would bypass this dependency
    # — they are disabled here and remounted below as real (authenticated)
    # routes: the schema names every route, model and constraint, and the
    # bearer policy applies to it like everything else.
    app = FastAPI(
        title="bakudo control plane",
        version="3.0.0",
        dependencies=[Depends(require_auth)],
        openapi_url=None,
        docs_url=None,
        redoc_url=None,
    )

    @app.get("/openapi.json", include_in_schema=False)
    def openapi_schema() -> dict[str, Any]:
        return app.openapi()

    @app.get("/docs", include_in_schema=False)
    def swagger_docs() -> HTMLResponse:
        return get_swagger_ui_html(openapi_url="/openapi.json", title=f"{app.title} - docs")

    @app.get("/redoc", include_in_schema=False)
    def redoc_docs() -> HTMLResponse:
        return get_redoc_html(openapi_url="/openapi.json", title=f"{app.title} - redoc")

    def resolve_sandbox() -> Callable[..., Any]:
        """Fail closed with a clear 409 instead of executing on the host."""
        try:
            return _resolve_sandbox()
        except RuntimeError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    @app.post("/objectives")
    def submit_objective(body: ObjectiveIn) -> dict[str, str]:
        from .. import ids

        doc = body.model_dump()
        doc["id"] = ids.objective_id()
        try:
            obj_id = tools.create_objective(doc)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        return {"id": obj_id}

    @app.get("/objectives")
    def list_objectives(queue: str = "ready") -> list[dict[str, Any]]:
        try:
            return tools.list_objectives(queue)
        except ValueError as exc:
            valid = ", ".join(q.value for q in QueueName)
            raise HTTPException(
                status_code=422, detail=f"invalid queue {queue!r}; valid queues: {valid}"
            ) from exc

    @app.post("/runs")
    def spawn_run(body: RunIn) -> dict[str, str]:
        # The explicit sandbox honours the fail-closed BAKUDO_SANDBOX policy
        # (OPT-10) instead of the tools default in-process local_sandbox.
        sandbox = resolve_sandbox()
        try:
            run_id = tools.spawn_agent_run(body.objective_id, body.agent, sandbox=sandbox)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        return {"run_id": run_id}

    @app.get("/runs/{run_id}")
    def get_run(run_id: str) -> dict[str, Any]:
        try:
            return tools.query_agent_run(run_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.get("/runs/{run_id}/logs")
    def get_logs(run_id: str) -> list[dict[str, Any]]:
        return tools.query_logs(run_id)

    @app.post("/optimize")
    def optimize(body: OptimizeIn) -> dict[str, Any]:
        """Drive one optimize objective through scout → attempts → selection.

        v0.1 runs the in-process loop synchronously (like the rest of this
        API); production submits ``OptimizationWorkflow`` via
        :func:`bakudo.temporal.client.start_optimization` instead.
        """
        from .. import ids
        from ..control.optimize import load_role_spec, run_optimize_loop
        from ..curriculum import Objective

        sandbox = resolve_sandbox()

        constraints: dict[str, Any] = {"avoidPublicApiChanges": True}
        if body.targetPaths:
            constraints["targetPaths"] = body.targetPaths
        if body.benchCommand:
            constraints["benchCommand"] = body.benchCommand
        if body.maxFilesChanged is not None:
            constraints["maxFilesChanged"] = body.maxFilesChanged

        try:
            objective = Objective.model_validate(
                {
                    "id": ids.objective_id(),
                    "type": "optimize",
                    "repo": body.repo,
                    "title": body.title,
                    "description": body.description,
                    "acceptanceCriteria": [
                        "All existing tests pass",
                        "No change is made unless it measurably improves the target",
                    ],
                    "constraints": constraints,
                }
            )
            objective.validate_against_schema()
            outcome = run_optimize_loop(
                objective,
                load_role_spec("optimize-scout"),
                load_role_spec("optimize-attempt"),
                max_rounds=body.maxRounds,
                max_approaches=body.maxApproaches,
                ledger=tools.ledger,
                sandbox=sandbox,
            )
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        return {"objective_id": objective.id, **outcome}

    def _resolve_promotion(
        promotion_id: str, approved: bool, body: PromotionResolutionIn
    ) -> dict[str, Any]:
        """Resolve a pending decision against the LEDGER's stored record."""
        try:
            decision = tools.ledger.resolve_promotion(
                promotion_id,
                approved=approved,
                approved_by=body.approved_by,
                comment=body.comment,
            )
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        return decision.to_dict()

    @app.post("/promotions/{promotion_id}/approve")
    def approve_promotion(
        promotion_id: str, body: PromotionResolutionIn
    ) -> dict[str, Any]:
        """Approve a pending promotion: candidate goes pending_human -> canary
        (spec §25.3). The old bulk /promotions/approve route that trusted
        caller-supplied scorecards is REMOVED (OPT-7/API-7)."""
        return _resolve_promotion(promotion_id, True, body)

    @app.post("/promotions/{promotion_id}/reject")
    def reject_promotion(
        promotion_id: str, body: PromotionResolutionIn
    ) -> dict[str, Any]:
        """Reject a pending promotion: candidate goes pending_human -> rejected."""
        return _resolve_promotion(promotion_id, False, body)

    @app.get("/promotions/pending")
    def pending_promotions() -> list[dict[str, Any]]:
        """Promotion decisions awaiting a human gate (spec sections 19.2, 26),
        read from the durable ledger (API-6)."""
        return [p.to_dict() for p in tools.ledger.promotions(status="pending")]

    @app.get("/status")
    def status() -> dict[str, Any]:
        return {"objectives": tools.queues.counts(), "mode": "sandbox-autonomous"}

    return app


def main() -> None:  # pragma: no cover - entrypoint
    import uvicorn

    host = os.environ.get("BAKUDO_API_HOST", "127.0.0.1")
    port = int(os.environ.get("BAKUDO_API_PORT", "8000"))
    uvicorn.run(build_app(), host=host, port=port)
