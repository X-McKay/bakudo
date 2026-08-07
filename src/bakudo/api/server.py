"""FastAPI control API (spec section 25).

In v0.1 the API drives an in-process :class:`MetaAgentTools` so the system is
demonstrable without a Temporal cluster. In production the same routes signal
the durable :class:`MetaAgentWorkflow` via :mod:`bakudo.temporal.client`.
"""

from __future__ import annotations

import os
from typing import Any

from pydantic import BaseModel

from ..control import MetaAgentTools


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


def build_app(tools: MetaAgentTools | None = None) -> Any:
    """Build the FastAPI app. Requires the ``api`` extra (fastapi, uvicorn)."""
    from fastapi import Depends, FastAPI, Header, HTTPException

    tools = tools or MetaAgentTools()
    app = FastAPI(title="bakudo control plane", version="3.0.0")

    # Optional bearer-token auth on mutating routes. When BAKUDO_API_TOKEN is
    # unset, auth is disabled (dev only); set it in any shared environment.
    api_token = os.environ.get("BAKUDO_API_TOKEN")

    def require_auth(authorization: str | None = Header(default=None)) -> None:
        if not api_token:
            return
        if authorization != f"Bearer {api_token}":
            raise HTTPException(status_code=401, detail="invalid or missing bearer token")

    auth = [Depends(require_auth)]

    @app.post("/objectives", dependencies=auth)
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
        return tools.list_objectives(queue)

    @app.post("/runs", dependencies=auth)
    def spawn_run(objective_id: str, agent: str) -> dict[str, str]:
        try:
            run_id = tools.spawn_agent_run(objective_id, agent)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except RuntimeError as exc:
            # Sandbox selection fails closed when BAKUDO_SANDBOX is not
            # configured; report a service misconfiguration, not a 500.
            raise HTTPException(status_code=503, detail=str(exc)) from exc
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

    @app.post("/optimize", dependencies=auth)
    def optimize(body: OptimizeIn) -> dict[str, Any]:
        """Drive one optimize objective through scout → attempts → selection.

        v0.1 runs the in-process loop synchronously (like the rest of this
        API); production submits ``OptimizationWorkflow`` via
        :func:`bakudo.temporal.client.start_optimization` instead.
        """
        from .. import ids
        from ..control.optimize import load_role_spec, run_optimize_loop
        from ..curriculum import Objective

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
            )
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        return {"objective_id": objective.id, **outcome}

    @app.post("/promotions/approve", dependencies=auth)
    def approve_promotion(candidate: dict[str, Any], baseline: dict[str, Any] | None = None):
        return tools.promote_candidate(candidate, baseline)

    @app.get("/promotions/pending")
    def pending_promotions() -> list[dict[str, Any]]:
        """Promotion decisions awaiting a human gate (spec sections 19.2, 26)."""
        promotions: list = getattr(tools.ledger, "promotions", lambda: [])()
        return [p.to_dict() for p in promotions if p.requires_human]

    @app.get("/status")
    def status() -> dict[str, Any]:
        return {"objectives": tools.queues.counts(), "mode": "sandbox-autonomous"}

    return app


def main() -> None:  # pragma: no cover - entrypoint
    import uvicorn

    host = os.environ.get("BAKUDO_API_HOST", "127.0.0.1")
    port = int(os.environ.get("BAKUDO_API_PORT", "8000"))
    uvicorn.run(build_app(), host=host, port=port)
