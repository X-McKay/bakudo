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


class ExperimentSpecIn(BaseModel):
    """Body of POST /experiments: an ExperimentSpec document (spec §7.1).

    Deliberately typed ``dict``-shaped (``model_config`` below) rather than
    re-declared field by field: the JSON Schema
    (:func:`bakudo.schema.validate_experiment_spec`) is the authoritative
    contract, checked explicitly in the handler before the pydantic model
    parse -- this wrapper exists only so FastAPI treats the payload as a
    real request body (module-scope model, per the 37c5db6 lesson at the
    top of this file), not so it re-validates structure fastapi already
    delegates onward.
    """

    model_config = {"extra": "allow"}


class RepoIn(BaseModel):
    """Body of POST /repos: same semantics as ``bakudo repo add`` (repo
    onboarding, P2 Task 1)."""

    source: str
    name: str | None = None
    baseRef: str | None = None


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
    source checkout and a wheel install (API-12). An install with no bundled
    agents data at all still boots — degraded, with a warning — and seed
    agents simply resolve as unknown (404), never a startup crash.
    """
    from .. import paths
    from ..agent_spec import load_spec_file

    try:
        agents = paths.agents_dir()
    except FileNotFoundError as exc:
        logger.warning("seed agents unavailable, registering none: %s", exc)
        return
    for spec_path in sorted(agents.glob("*.yaml")):
        tools.register_agent_spec(load_spec_file(spec_path))


def build_app(tools: MetaAgentTools | None = None) -> Any:
    """Build the FastAPI app. Requires the ``api`` extra (fastapi, uvicorn)."""
    from fastapi import Depends, FastAPI, HTTPException
    from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

    tools = tools or MetaAgentTools()
    _register_repo_agent_specs(tools)

    # Bearer-token auth on every route (API-1). When BAKUDO_API_TOKEN is unset,
    # auth is disabled (dev only) — warned once here; set it in any shared
    # environment. HTTPBearer is a DECLARED security scheme (not a bare Header
    # read), so /openapi.json documents the auth model and Swagger UI offers
    # an Authorize button for try-it-out.
    api_token = os.environ.get("BAKUDO_API_TOKEN")
    if not api_token:
        logger.warning("API auth disabled: BAKUDO_API_TOKEN not set")

    bearer_scheme = HTTPBearer(auto_error=False)

    def require_auth(
        credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),  # noqa: B008
    ) -> None:
        if not api_token:
            return
        supplied = (credentials.credentials if credentials else "").encode("utf-8")
        if not secrets.compare_digest(supplied, api_token.encode("utf-8")):
            raise HTTPException(status_code=401, detail="invalid or missing bearer token")

    from fastapi.openapi.docs import get_redoc_html, get_swagger_ui_html
    from fastapi.responses import HTMLResponse

    # App-level dependency: every route, read and write, requires the token
    # when one is configured. FastAPI's default /openapi.json//docs//redoc
    # endpoints are NOT path operations, so they would bypass this dependency
    # — they are disabled here and remounted below as real (authenticated)
    # routes: the schema names every route, model and constraint, and the
    # bearer policy applies to it like everything else.
    #
    # Docs posture: interactive docs are fully usable in tokenless dev mode.
    # In token-secured deployments the docs pages 401 on plain browser
    # navigation like the schema does; use the schema with the token
    # (curl/codegen) or front the API with a header-injecting proxy — the
    # proxy injects on the page load and on Swagger UI's /openapi.json XHR
    # alike, and the declared HTTPBearer scheme provides the Authorize button
    # for try-it-out requests.
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
    def approve_promotion(promotion_id: str, body: PromotionResolutionIn) -> dict[str, Any]:
        """Approve a pending promotion: candidate goes pending_human -> canary
        (spec §25.3). The old bulk /promotions/approve route that trusted
        caller-supplied scorecards is REMOVED (OPT-7/API-7)."""
        return _resolve_promotion(promotion_id, True, body)

    @app.post("/promotions/{promotion_id}/reject")
    def reject_promotion(promotion_id: str, body: PromotionResolutionIn) -> dict[str, Any]:
        """Reject a pending promotion: candidate goes pending_human -> rejected."""
        return _resolve_promotion(promotion_id, False, body)

    @app.get("/promotions/pending")
    def pending_promotions() -> list[dict[str, Any]]:
        """Promotion decisions awaiting a human gate (spec sections 19.2, 26),
        read from the durable ledger (API-6)."""
        return [p.to_dict() for p in tools.ledger.promotions(status="pending")]

    @app.post("/experiments")
    def submit_experiment(body: ExperimentSpecIn) -> dict[str, str]:
        """Run an ExperimentSpec synchronously (design doc §7, T10): schema
        + pydantic validated, then executed in process against the
        LEDGER-backed ``tools.ledger`` so GET /experiments/{id} and
        GET /trials/{id} can read it back. Same fail-closed sandbox policy
        as /runs and /optimize (OPT-10) gates live execution -- 409 when
        unresolvable, exactly like the existing sandbox-unavailable
        handling. Verifier-test grading additionally requires
        ``BAKUDO_ENV=dev`` (ruling R2): it always executes task
        fixture/agent code directly on this host via the local test
        runner, independent of whichever sandbox drives the AGENT.
        """
        import os

        from .. import paths
        from ..experiments.models import ExperimentSpec
        from ..experiments.runner import (
            adapt_sandbox_fn,
            resolve_arm_pipeline_fn,
            run_experiment,
        )
        from ..schema import validate_experiment_spec
        from ..tasks.source import default_task_source
        from ..tasks.verifier_runner import local_verifier_runner

        sandbox = resolve_sandbox()
        if os.environ.get("BAKUDO_ENV") != "dev":
            raise HTTPException(
                status_code=409,
                detail=(
                    "POST /experiments grades verifier tests with the local test "
                    "runner, which executes task fixture/agent code "
                    "directly on this host; set BAKUDO_ENV=dev to allow it."
                ),
            )

        document = body.model_dump()
        try:
            validate_experiment_spec(document)
            spec = ExperimentSpec.model_validate(document)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=422, detail=str(exc)) from exc

        try:
            task_source = default_task_source()
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=422, detail=str(exc)) from exc

        try:
            resolved_spec, pipeline_fn = resolve_arm_pipeline_fn(
                spec, sandbox_fn=adapt_sandbox_fn(sandbox), agents_root=paths.agents_dir()
            )
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

        result = run_experiment(
            resolved_spec,
            task_source=task_source,
            ledger=tools.ledger,
            pipeline_fn=pipeline_fn,
            verifier_runner=local_verifier_runner,
        )
        return {"id": result["experimentId"]}

    @app.get("/experiments/{experiment_id}")
    def get_experiment(experiment_id: str) -> dict[str, Any]:
        experiment = tools.ledger.get_experiment(experiment_id)
        if experiment is None:
            raise HTTPException(status_code=404, detail=f"Unknown experiment: {experiment_id}")
        return experiment

    @app.get("/trials/{trial_id}")
    def get_trial(trial_id: str) -> dict[str, Any]:
        trial = tools.ledger.get_trial(trial_id)
        if trial is None:
            raise HTTPException(status_code=404, detail=f"Unknown trial: {trial_id}")
        return trial.model_dump(mode="json")

    @app.post("/repos")
    def add_repo(body: RepoIn) -> dict[str, Any]:
        """Clone (URL) or register in place (local path) a repo checkout --
        same semantics as ``bakudo repo add`` (repo onboarding, P2 Task 1).
        Clone only, never execute: a plain ``git clone`` subprocess."""
        from ..registry.repos import (
            RepoCloneError,
            RepoSourceInvalidError,
            RepoTargetExistsError,
        )
        from ..registry.repos import add_repo as add_repo_record

        try:
            record = add_repo_record(
                body.source,
                name=body.name,
                base_ref=body.baseRef,
                ledger=tools.ledger,
            )
        except RepoTargetExistsError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        except RepoSourceInvalidError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except RepoCloneError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        return record.model_dump(mode="json")

    @app.get("/repos")
    def list_repos() -> list[dict[str, Any]]:
        return [r.model_dump(mode="json") for r in tools.ledger.list_repos()]

    @app.get("/status")
    def status() -> dict[str, Any]:
        return {"objectives": tools.queues.counts(), "mode": "sandbox-autonomous"}

    return app


def main() -> None:  # pragma: no cover - entrypoint
    import uvicorn

    host = os.environ.get("BAKUDO_API_HOST", "127.0.0.1")
    port = int(os.environ.get("BAKUDO_API_PORT", "8000"))
    uvicorn.run(build_app(), host=host, port=port)
