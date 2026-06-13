"""FastAPI control API (spec section 25).

In v0.1 the API drives an in-process :class:`MetaAgentTools` so the system is
demonstrable without a Temporal cluster. In production the same routes signal
the durable :class:`MetaAgentWorkflow` via :mod:`bakudo.temporal.client`.
"""

from __future__ import annotations

import os
from typing import Any

from ..control import MetaAgentTools


def build_app(tools: MetaAgentTools | None = None) -> Any:
    """Build the FastAPI app. Requires the ``api`` extra (fastapi, uvicorn)."""
    from fastapi import FastAPI, HTTPException
    from pydantic import BaseModel

    tools = tools or MetaAgentTools()
    app = FastAPI(title="bakudo control plane", version="3.0.0")

    class ObjectiveIn(BaseModel):
        repo: str
        type: str
        title: str
        description: str = ""
        acceptanceCriteria: list[str] = []
        constraints: dict[str, Any] = {}

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
        return tools.list_objectives(queue)

    @app.post("/runs")
    def spawn_run(objective_id: str, agent: str) -> dict[str, str]:
        try:
            run_id = tools.spawn_agent_run(objective_id, agent)
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

    @app.post("/promotions/approve")
    def approve_promotion(candidate: dict[str, Any], baseline: dict[str, Any] | None = None):
        return tools.promote_candidate(candidate, baseline)

    @app.get("/status")
    def status() -> dict[str, Any]:
        return {"objectives": tools.queues.counts(), "mode": "sandbox-autonomous"}

    return app


def main() -> None:  # pragma: no cover - entrypoint
    import uvicorn

    host = os.environ.get("BAKUDO_API_HOST", "127.0.0.1")
    port = int(os.environ.get("BAKUDO_API_PORT", "8000"))
    uvicorn.run(build_app(), host=host, port=port)
