"""FastAPI control API (spec section 25).

In v0.1 the API drives an in-process :class:`MetaAgentTools` so the system is
demonstrable without a Temporal cluster. In production the same routes signal
the durable :class:`MetaAgentWorkflow` via :mod:`bakudo.temporal.client`.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel

from ..config import Settings
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
    api_token = Settings.from_env().api_token

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

    @app.post("/runs", dependencies=auth, status_code=202)
    def spawn_run(objective_id: str, agent: str) -> dict[str, str]:
        """Accept a run and return immediately; poll GET /runs/{id} for phase.

        A real sandboxed run takes minutes to hours — holding the HTTP
        connection for its duration exhausted the threadpool under any
        concurrency, so acceptance and execution are decoupled (202 pattern).
        """
        # Resolve the sandbox up front so a misconfigured service rejects at
        # accept time (503) instead of failing invisibly in the background.
        from ..abox.select import resolve_sandbox

        try:
            resolve_sandbox()
            run_id = tools.spawn_agent_run_async(objective_id, agent)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except RuntimeError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        return {"run_id": run_id, "status_url": f"/runs/{run_id}"}

    @app.get("/runs/{run_id}")
    def get_run(run_id: str) -> dict[str, Any]:
        try:
            return tools.query_agent_run(run_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.get("/runs/{run_id}/logs")
    def get_logs(run_id: str) -> list[dict[str, Any]]:
        return tools.query_logs(run_id)

    # Background optimize jobs: objective_id -> future. A multi-round loop
    # with real models runs for hours; the API accepts and hands back a poll
    # URL instead of holding the connection (202 pattern).
    optimize_jobs: dict[str, Any] = {}

    @app.post("/optimize", dependencies=auth, status_code=202)
    def optimize(body: OptimizeIn) -> dict[str, Any]:
        """Accept one optimize objective; poll GET /optimize/{objective_id}."""
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
            scout_spec = load_role_spec("optimize-scout")
            attempt_spec = load_role_spec("optimize-attempt")
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=422, detail=str(exc)) from exc

        def execute() -> dict[str, Any]:
            return run_optimize_loop(
                objective,
                scout_spec,
                attempt_spec,
                max_rounds=body.maxRounds,
                max_approaches=body.maxApproaches,
                ledger=tools.ledger,
            )

        optimize_jobs[objective.id] = tools._jobs().submit(execute)
        return {
            "objective_id": objective.id,
            "status_url": f"/optimize/{objective.id}",
        }

    @app.get("/optimize/{objective_id}")
    def optimize_status(objective_id: str) -> dict[str, Any]:
        job = optimize_jobs.get(objective_id)
        if job is None:
            raise HTTPException(status_code=404, detail=f"Unknown job: {objective_id}")
        if not job.done():
            return {"objective_id": objective_id, "status": "running"}
        try:
            outcome = job.result()
        except Exception as exc:  # noqa: BLE001 - surface the job's failure
            return {"objective_id": objective_id, "status": "error", "error": str(exc)}
        return {"objective_id": objective_id, **outcome}

    @app.post("/promotions/approve", dependencies=auth)
    def approve_promotion(candidate: dict[str, Any], baseline: dict[str, Any] | None = None):
        return tools.promote_candidate(candidate, baseline)

    @app.get("/promotions/pending")
    def pending_promotions() -> list[dict[str, Any]]:
        """Promotion decisions awaiting a human gate (spec sections 19.2, 26)."""
        return [p.to_dict() for p in tools.ledger.promotions() if p.requires_human]

    @app.get("/status")
    def status() -> dict[str, Any]:
        return {"objectives": tools.queues.counts(), "mode": "sandbox-autonomous"}

    return app


def main() -> None:  # pragma: no cover - entrypoint
    import uvicorn

    settings = Settings.from_env()
    uvicorn.run(build_app(), host=settings.api_host, port=settings.api_port)
