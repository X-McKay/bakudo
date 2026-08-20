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
from typing import Any, Protocol

from pydantic import BaseModel, Field

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
    acceptanceCriteria: list[str] = Field(default_factory=list)
    constraints: dict[str, Any] = Field(default_factory=dict)


class OptimizeIn(BaseModel):
    repo: str
    title: str
    description: str = ""
    targetPaths: list[str] = Field(default_factory=list)
    performance: dict[str, Any]
    maxFilesChanged: int | None = None
    maxRounds: int = 2
    maxApproaches: int = 3
    seed: int = 0


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


class WorkloadValidateIn(BaseModel):
    """Manifest-only validation; corpus bytes are published through trusted tooling."""

    document: dict[str, Any]


class PerformanceMeasurementIn(BaseModel):
    repository: str
    workload: str
    revision: str = "HEAD"
    source: str | None = None
    environment: dict[str, Any]


class PerformanceCaptureIn(BaseModel):
    repository: str
    workload: str
    revision: str = "HEAD"
    profiler: str
    source: str | None = None
    environment: dict[str, Any]


class PerformanceComparisonIn(BaseModel):
    repository: str
    workload: str
    baseline_revision: str = Field(alias="baselineRevision")
    candidate_revision: str = Field(alias="candidateRevision")
    source: str | None = None
    environment: dict[str, Any]
    primary_metric: str | None = Field(default=None, alias="primaryMetric")
    protected_metrics: list[str] = Field(default_factory=list, alias="protectedMetrics")
    confidence: float = Field(default=0.95, gt=0, lt=1)
    bootstrap_resamples: int = Field(default=10_000, alias="bootstrapResamples", ge=1)
    seed: int = 0


class PerformanceDispatcher(Protocol):
    """Durable operation-start port, normally backed by Temporal."""

    def start_measurement(self, request: PerformanceMeasurementIn) -> str: ...

    def start_capture(self, request: PerformanceCaptureIn) -> str: ...

    def start_comparison(self, request: PerformanceComparisonIn) -> str: ...


def _resolve_sandbox() -> Callable[..., Any]:
    """Resolve the run sandbox with the same fail-closed policy as the
    Temporal activity layer (:meth:`bakudo.temporal._impl.Deps.sandbox_fn`,
    importable without the ``temporal`` extra): ``BAKUDO_SANDBOX`` must be
    ``abox`` or ``local``, ``local`` additionally requires ``BAKUDO_ENV=dev``,
    and unset raises instead of silently executing on the host (OPT-10).
    """
    from ..temporal._impl import Deps

    return Deps(memory=None).sandbox_fn()


def _build_optimize_performance_compare(objective: Any, ledger: Any, *, seed: int):
    """Pin the trusted workload/baseline before synchronous API attempts run."""

    from pathlib import Path

    from ..abox.measurement import AboxWorkloadInvoker
    from ..performance.environment import configured_environment_pin
    from ..performance.revisions import pin_repository_revision
    from ..performance.service import PerformanceMeasurementService
    from ..performance.source import default_workload_source

    contract = objective.performance
    if contract is None:
        raise ValueError("optimize objective requires a performance contract")
    workload = default_workload_source().load(contract.workload_ref.ref)
    if contract.workload_pin is not None and workload.pin != contract.workload_pin:
        raise ValueError("loaded workload does not match the objective workloadPin")
    if workload.spec.subject.repo != objective.repo:
        raise ValueError(
            f"workload subject {workload.spec.subject.repo!r} does not match "
            f"repository {objective.repo!r}"
        )
    registered = ledger.get_repo(objective.repo)
    if registered is not None:
        repo_path = Path(registered.path).expanduser().resolve()
    else:
        direct = Path(objective.repo).expanduser()
        if not direct.is_dir():
            raise ValueError(
                f"unknown repository {objective.repo!r}; register it with `bakudo repo add`"
            )
        repo_path = direct.resolve()
    environment = configured_environment_pin()
    baseline = pin_repository_revision(
        repo_path,
        repository=objective.repo,
        require_clean=True,
    )
    ledger.record_workload_version(workload.spec, workload.pin)
    policy = contract.decision_policy

    def compare_candidate(diff: str):
        candidate = pin_repository_revision(
            repo_path,
            baseline.commit_sha,
            repository=objective.repo,
            patch=diff,
            require_clean=True,
        )
        assert candidate.patch_digest is not None
        invoker = AboxWorkloadInvoker(
            repo_resolver=lambda _name: repo_path,
            candidate_patches={candidate.patch_digest: diff},
        )
        return (
            PerformanceMeasurementService(invoker, ledger=ledger)
            .compare(
                workload,
                baseline,
                candidate,
                environment,
                environment,
                seed=seed,
                primary_metric=contract.primary_metric,
                protected_metrics=policy.protected_metrics,
                confidence=policy.confidence,
                bootstrap_resamples=policy.bootstrap_resamples,
            )
            .comparison
        )

    return compare_candidate


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


def build_app(
    tools: MetaAgentTools | None = None,
    *,
    performance_dispatcher: PerformanceDispatcher | None = None,
    workload_source: Any | None = None,
) -> Any:
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

    def require_performance_dispatcher() -> PerformanceDispatcher:
        if performance_dispatcher is None:
            raise HTTPException(
                status_code=409,
                detail=(
                    "performance workflow dispatch is not configured; start a Temporal "
                    "worker/client or use `bakudo performance ... --sync`"
                ),
            )
        return performance_dispatcher

    def dispatch_performance(start: Callable[[], str]) -> str:
        from ..temporal.performance_dispatch import (
            PerformanceDispatchError,
            PerformanceSubmissionError,
        )

        try:
            return start()
        except PerformanceSubmissionError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        except (PerformanceDispatchError, OSError, ValueError) as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    def resolve_workload_source():
        if workload_source is not None:
            return workload_source
        from ..performance.source import default_workload_source

        try:
            return default_workload_source()
        except Exception as exc:  # noqa: BLE001 - configuration becomes an API conflict
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    @app.get("/workloads")
    def list_workloads() -> list[dict[str, Any]]:
        source = resolve_workload_source()
        return [
            {
                "ref": summary.ref,
                "name": summary.name,
                "version": summary.version,
                "description": summary.description,
                "labels": summary.labels,
                "manifestDigest": summary.manifest_digest,
                "sourceURI": source.source_uri,
                "collectionRevision": source.collection_revision,
            }
            for summary in source.list()
        ]

    @app.post("/workloads/validate")
    def validate_workload(body: WorkloadValidateIn) -> dict[str, Any]:
        from ..performance.models import WorkloadSpec, canonical_digest
        from ..schema import validate_workload_spec

        try:
            validate_workload_spec(body.document)
            spec = WorkloadSpec.model_validate(body.document)
        except Exception as exc:  # noqa: BLE001 - stable validation error response
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        return {
            "ok": True,
            "ref": spec.ref,
            "manifestDigest": canonical_digest(spec),
        }

    @app.post("/performance/measurements", status_code=202)
    def start_performance_measurement(body: PerformanceMeasurementIn) -> dict[str, str]:
        operation_id = dispatch_performance(
            lambda: require_performance_dispatcher().start_measurement(body)
        )
        return {"operation_id": operation_id}

    @app.post("/performance/captures", status_code=202)
    def start_performance_capture(body: PerformanceCaptureIn) -> dict[str, str]:
        operation_id = dispatch_performance(
            lambda: require_performance_dispatcher().start_capture(body)
        )
        return {"operation_id": operation_id}

    @app.post("/performance/comparisons", status_code=202)
    def start_performance_comparison(body: PerformanceComparisonIn) -> dict[str, str]:
        operation_id = dispatch_performance(
            lambda: require_performance_dispatcher().start_comparison(body)
        )
        return {"operation_id": operation_id}

    @app.get("/performance/records/{record_id}")
    def get_performance_record(record_id: str) -> dict[str, Any]:
        record: Any | None
        if record_id.startswith("measurement_"):
            record = tools.ledger.get_measurement(record_id)
        elif record_id.startswith("snapshot_"):
            record = tools.ledger.get_performance_snapshot(record_id)
        elif record_id.startswith("comparison_"):
            record = tools.ledger.get_performance_comparison(record_id)
        else:
            raise HTTPException(
                status_code=422,
                detail="record ID must start with measurement_, snapshot_, or comparison_",
            )
        if record is None:
            raise HTTPException(status_code=404, detail=f"unknown record: {record_id}")
        return record.model_dump(by_alias=True, mode="json", exclude_none=True)

    @app.get("/performance/regressions")
    def list_performance_regressions(repository: str | None = None) -> list[dict[str, Any]]:
        return [
            signal.model_dump(by_alias=True, mode="json", exclude_none=True)
            for signal in tools.ledger.list_performance_regressions(repository)
        ]

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
                    "performance": body.performance,
                }
            )
            objective.validate_against_schema()
            performance_compare = _build_optimize_performance_compare(
                objective, tools.ledger, seed=body.seed
            )
            outcome = run_optimize_loop(
                objective,
                load_role_spec("optimize-scout"),
                load_role_spec("optimize-attempt"),
                max_rounds=body.maxRounds,
                max_approaches=body.maxApproaches,
                ledger=tools.ledger,
                sandbox=sandbox,
                performance_compare=performance_compare,
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
        """Run either explicit ExperimentSpec subject synchronously.

        Agent subjects use the fail-closed agent sandbox and independent task
        verifier. Software-artifact subjects instead use the configured
        workload, environment pin, abox measurement service, and persisted
        MeasurementRecord IDs; they never execute through the agent verifier.
        """
        import os

        from .. import paths
        from ..experiments.models import ExperimentSpec, SoftwareArtifactSubject
        from ..experiments.runner import (
            adapt_sandbox_fn,
            resolve_arm_pipeline_fn,
            run_experiment,
        )
        from ..schema import validate_experiment_spec
        from ..tasks.source import default_task_source
        from ..tasks.verifier_runner import local_verifier_runner

        document = body.model_dump()
        try:
            validate_experiment_spec(document)
            spec = ExperimentSpec.model_validate(document)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=422, detail=str(exc)) from exc

        if isinstance(spec.subject, SoftwareArtifactSubject):
            from ..experiments.configured import configured_artifact_measurement_observer

            try:
                observer = configured_artifact_measurement_observer(spec, ledger=tools.ledger)
                result = run_experiment(
                    spec,
                    ledger=tools.ledger,
                    artifact_measure=observer,
                )
            except Exception as exc:  # noqa: BLE001 - stable HTTP boundary
                raise HTTPException(status_code=422, detail=str(exc)) from exc
            return {"id": result["experimentId"]}

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

    from ..registry.factory import ledger_from_env
    from ..temporal.performance_dispatch import TemporalPerformanceDispatcher

    host = os.environ.get("BAKUDO_API_HOST", "127.0.0.1")
    port = int(os.environ.get("BAKUDO_API_PORT", "8000"))
    tools = MetaAgentTools(ledger=ledger_from_env())
    dispatcher = TemporalPerformanceDispatcher(tools.ledger)
    uvicorn.run(
        build_app(tools, performance_dispatcher=dispatcher),
        host=host,
        port=port,
    )
