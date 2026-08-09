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
from pathlib import Path
from typing import Any

from pydantic import BaseModel, ValidationError

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
    """Register the repo's seed agents (``agents/*.yaml``) at startup with the
    same loader the CLI uses, so ``POST /runs`` resolves them by name and
    'Unknown agent' only means a genuinely unknown name (API-8).

    Source-tree-relative like the CLI loaders; installs without an ``agents/``
    directory register nothing (API-12 tracks that packaging gap).
    """
    from ..agent_spec import load_spec_file

    agents_dir = Path(__file__).resolve().parents[3] / "agents"
    if not agents_dir.is_dir():  # pragma: no cover - wheel installs
        return
    for spec_path in sorted(agents_dir.glob("*.yaml")):
        tools.register_agent_spec(load_spec_file(spec_path))


def _spawn_agent_run(
    tools: MetaAgentTools, objective_id: str, agent: str, sandbox: Callable[..., Any]
) -> str:
    """Mirror :meth:`MetaAgentTools.spawn_agent_run` with an explicit sandbox.

    The tools method defaults to the in-process ``local_sandbox``; the API must
    instead honour the fail-closed ``BAKUDO_SANDBOX`` policy (OPT-10), so it
    threads the resolved sandbox into the pipeline itself.
    """
    from ..control.pipeline import run_objective

    objective = tools._objectives[objective_id]
    spec = tools._resolve_spec(agent)
    pipeline = run_objective(objective, spec, ledger=tools.ledger, sandbox=sandbox)
    tools._runs[pipeline.run_id] = pipeline
    return pipeline.run_id


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

    # App-level dependency: every route, read and write, requires the token
    # when one is configured. (FastAPI's /openapi.json and /docs endpoints are
    # not path operations and stay open; they expose the schema, not data.)
    app = FastAPI(
        title="bakudo control plane", version="3.0.0", dependencies=[Depends(require_auth)]
    )

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
        sandbox = resolve_sandbox()
        try:
            run_id = _spawn_agent_run(tools, body.objective_id, body.agent, sandbox)
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

    @app.post("/promotions/approve")
    def approve_promotion(
        candidate: dict[str, Any], baseline: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        try:
            return tools.promote_candidate(candidate, baseline)
        except ValidationError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

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
