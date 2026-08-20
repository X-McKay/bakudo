"""Plain (SDK-free) implementations behind the Temporal activities.

Keeping the logic here means it is exercised by unit tests without a Temporal
worker. A process-global :class:`Deps` bundle lets the worker inject the real
ledger and sandbox driver; tests use the in-memory defaults.
"""

from __future__ import annotations

import os
import tempfile
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any, Protocol

from .. import __version__ as bakudo_version
from .. import ids, paths
from ..abox.local import local_sandbox
from ..abox.runner import AboxOutcome, AboxRunner
from ..agent_run_bundle import AgentRunBundle, Budget, MemoryExcerpt
from ..agent_spec import AgentSpec, parse_spec
from ..curriculum import build_default_collector, generate_objectives
from ..curriculum.collectors import SignalCollector
from ..curriculum.objective import Objective
from ..evals import EvalContext, Scorecard, assemble_suite, decide
from ..evals.corpus import CaseRun, load_corpus_from_tasks
from ..evals.evolution import evolve_agent
from ..evals.promotion import PromotionPolicy, apply_decision, routes_to_canary
from ..memory.compaction import compact
from ..memory.semantic import SemanticMemoryStore
from ..performance.compatibility import CompatibilityPolicy
from ..performance.environment import configured_environment_pin
from ..performance.models import (
    FailureReason,
    IntegrityResult,
    InvocationOutcome,
    InvocationPhase,
    PerformanceSnapshot,
    ProfilerSpec,
    RecordStatus,
)
from ..performance.pins import EnvironmentPin, RevisionPin, WorkloadPin
from ..performance.profiler import (
    ProfileCaptureError,
    ProfileExecutionError,
    ProfilerUnsupportedError,
    ProfileTimeoutError,
)
from ..performance.readiness import PerformanceRunnerReadinessError
from ..performance.revisions import pin_repository_revision
from ..performance.service import (
    PerformanceMeasurementService,
    PerformanceServiceError,
    WorkloadInvoker,
)
from ..performance.source import (
    LoadedWorkload,
    WorkloadLoadError,
    durable_workload_source_location,
    workload_source_from_location,
)
from ..registry import InMemoryLedger, RunPhase, RunRecord
from ..registry.ledger import Ledger
from ..runner.result import RunResult
from ..tasks.provision import provision
from ..tasks.verifier_runner import VerificationResult, VerifierRunner
from ..trials.models import TrialRecord
from .shared import (
    AgentRunInput,
    CompactionInput,
    EvalInput,
    EvolutionInput,
    ObserveInput,
    PerformanceCaptureInput,
    PerformanceComparisonInput,
    PerformanceMeasurementInput,
    PerformanceWorkflowResult,
    PromotionInput,
)

if TYPE_CHECKING:
    from ..performance.source import WorkloadSource
    from ..tasks.source import TaskSource

SandboxFn = Callable[[AgentRunBundle], AboxOutcome]
TaskSourceFn = Callable[[], "TaskSource"]
PerformanceWorkloadSourceFn = Callable[[], "WorkloadSource"]


class PerformanceCaptureService(Protocol):
    """Provision-and-capture port owned by the performance activity boundary."""

    def capture(
        self,
        workload: LoadedWorkload,
        revision: RevisionPin,
        environment: EnvironmentPin,
        profiler: ProfilerSpec,
        *,
        snapshot_id: str,
        cancel_event: object | None = None,
    ) -> PerformanceSnapshot: ...


# How to turn a sandbox-less deployment into a sandboxed one (TMP-13). Shared
# by the fail-fast RuntimeError below and the worker's startup posture log
# (bakudo.temporal.worker.log_sandbox_posture) so the two can never drift.
SANDBOX_REMEDIATION = (
    "To enable real sandboxing, mount the host abox binary and /dev/kvm into "
    "the worker and set BAKUDO_SANDBOX=abox (see infra/docker-compose.yml)."
)

# Mirrors SANDBOX_REMEDIATION: single source of truth for the verifier-eval
# fail-closed message, shared by Deps.resolve_verifier_eval_fn (runtime) and
# any future worker startup posture log, so the two can never drift.
VERIFIER_EVAL_REMEDIATION = (
    "grading verifier tests outside BAKUDO_ENV=dev requires a resolvable "
    "sandbox posture: set BAKUDO_ENV=dev to use the local (host-executing, "
    "dev-only) test runner, or BAKUDO_SANDBOX=abox to grade inside a real "
    "abox guest (bakudo.abox.verifier.abox_verifier_runner), or inject "
    "Deps.verifier_eval_fn with a trusted runner."
)


def resolve_sandbox_mode() -> str | None:
    """Return the configured ``BAKUDO_SANDBOX`` mode, or ``None`` when unset.

    The single source of truth for mode resolution — :meth:`Deps.sandbox_fn`
    (runtime behavior) and the worker's startup posture log both use it.
    """
    return os.environ.get("BAKUDO_SANDBOX")


def _default_task_source() -> TaskSource:
    """Resolve the configured runtime task source.

    Assigned as ``Deps.task_source_fn``'s default *value* (a function
    reference, not a call) so no directory I/O happens at ``Deps()``
    construction/import time -- only when an activity actually resolves the
    source.
    """
    from ..tasks.source import default_task_source

    return default_task_source()


def _default_performance_workload_source() -> WorkloadSource:
    from ..performance.source import default_workload_source

    return default_workload_source()


def _default_verifier_eval_fn(workspace: Any, command: str) -> VerificationResult:
    """Fail-closed default verifier-test runner (mirrors ``Deps.sandbox_fn``'s
    resolution pattern, :func:`resolve_sandbox_mode`).

    ``BAKUDO_ENV=dev`` opts into the local, host-executing runner (the same
    one ``bakudo trial run``/``bakudo experiment run`` use in dev mode).
    Otherwise, ``resolve_sandbox_mode() == "abox"`` opts into the real
    abox-backed guest runner (:func:`bakudo.abox.verifier.abox_verifier_runner`,
    Task 8) -- the same posture check ``Deps.sandbox_fn`` uses for the agent
    sandbox itself, so verifier-test grading and agent execution can never
    silently disagree about whether abox is the live boundary. Any other
    posture refuses rather than silently executing untrusted diff-adjacent
    code on the host.
    """
    if os.environ.get("BAKUDO_ENV") == "dev":
        from ..tasks.verifier_runner import local_verifier_runner

        return local_verifier_runner(workspace, command)
    if resolve_sandbox_mode() == "abox":
        from ..abox.verifier import abox_verifier_runner

        return abox_verifier_runner(workspace, command)
    raise RuntimeError(VERIFIER_EVAL_REMEDIATION)


@dataclass
class Deps:
    """Injectable dependencies for the activity implementations."""

    ledger: Ledger = field(default_factory=InMemoryLedger)
    sandbox: SandboxFn | None = None
    memory: object = field(default_factory=SemanticMemoryStore)
    collector: SignalCollector | None = None
    # A factory returning a TaskSource (never a source instance -- resolving
    # one may perform directory or archive I/O, so
    # activities call this fresh rather than sharing a stale instance across
    # a long-lived worker process) and the verifier-test VerifierRunner. Both
    # default to real, env/paths-driven behavior (see the module-level
    # functions above) so tests are the only callers that need to override
    # them.
    task_source_fn: TaskSourceFn = _default_task_source
    verifier_eval_fn: VerifierRunner = _default_verifier_eval_fn
    # Task 7: threaded into build_pipeline_fn's run_objective_fn param by
    # _task_case_run_fn (the task-backed evolve default). None (the
    # production default) resolves to the real
    # bakudo.control.pipeline.run_objective there; tests inject a stub so an
    # evolution run over the task-backed default corpus stays offline.
    run_objective_fn: Callable[..., Any] | None = None
    # Performance I/O is resolved only in activities. The source is a factory
    # because loading snapshots performs filesystem work; the invoker and
    # capture service are replaceable ports for hosted workers and tests.
    performance_workload_source_fn: PerformanceWorkloadSourceFn = (
        _default_performance_workload_source
    )
    performance_invoker: WorkloadInvoker | None = None
    performance_capture: PerformanceCaptureService | None = None

    def performance_invoker_or_none(
        self, candidate_patches: dict[str, str] | None = None
    ) -> WorkloadInvoker | None:
        if self.performance_invoker is not None:
            return self.performance_invoker
        if resolve_sandbox_mode() != "abox":
            return None
        from ..abox.measurement import AboxWorkloadInvoker

        return AboxWorkloadInvoker(candidate_patches=candidate_patches)

    def sandbox_fn(self) -> SandboxFn:
        """Resolve the sandbox driver, failing *closed*.

        The in-process ``local_sandbox`` is not an isolation boundary, so it is
        never selected implicitly: ``BAKUDO_SANDBOX`` must be ``abox`` or
        ``local``, and ``local`` is only permitted when ``BAKUDO_ENV=dev``.
        """
        if self.sandbox is not None:
            return self.sandbox

        mode = resolve_sandbox_mode()

        if mode == "abox":
            return AboxRunner().run
        if mode == "local":
            if os.environ.get("BAKUDO_ENV") != "dev":
                raise RuntimeError(
                    "BAKUDO_SANDBOX=local requires BAKUDO_ENV=dev; the local "
                    "sandbox is not an isolation boundary."
                )
            return local_sandbox
        if mode == "unavailable":
            # TMP-13: the declared posture of deployments that cannot sandbox
            # (e.g. the default docker-compose worker image, which ships no
            # abox binary or KVM). Fail loud and actionable, never hang or
            # silently no-op.
            raise RuntimeError(
                "sandbox runs are unavailable in this deployment "
                "(BAKUDO_SANDBOX=unavailable): the worker image has no abox "
                f"binary and no /dev/kvm. {SANDBOX_REMEDIATION}"
            )
        if mode is None:
            raise RuntimeError(
                "BAKUDO_SANDBOX must be set to 'abox' or 'local' "
                "(local is dev-only). Refusing to pick a sandbox implicitly."
            )
        raise RuntimeError(f"Unknown BAKUDO_SANDBOX value: {mode!r}")


DEPS = Deps()

# The promotion policy consulted by the graduation/decision activities.
# Module-level so operators/tests can swap it without patching call sites.
PROMOTION_POLICY = PromotionPolicy()


def configure(
    *,
    ledger: Ledger | None = None,
    sandbox: SandboxFn | None = None,
    memory: object | None = None,
    collector: SignalCollector | None = None,
    task_source_fn: TaskSourceFn | None = None,
    verifier_eval_fn: VerifierRunner | None = None,
    performance_workload_source_fn: PerformanceWorkloadSourceFn | None = None,
    performance_invoker: WorkloadInvoker | None = None,
    performance_capture: PerformanceCaptureService | None = None,
) -> None:
    """Inject real dependencies (called by the worker entrypoint)."""
    if ledger is not None:
        DEPS.ledger = ledger
    if sandbox is not None:
        DEPS.sandbox = sandbox
    if memory is not None:
        DEPS.memory = memory
    if collector is not None:
        DEPS.collector = collector
    if task_source_fn is not None:
        DEPS.task_source_fn = task_source_fn
    if verifier_eval_fn is not None:
        DEPS.verifier_eval_fn = verifier_eval_fn
    if performance_workload_source_fn is not None:
        DEPS.performance_workload_source_fn = performance_workload_source_fn
    if performance_invoker is not None:
        DEPS.performance_invoker = performance_invoker
    if performance_capture is not None:
        DEPS.performance_capture = performance_capture


def _budget_for(spec: AgentSpec) -> Budget:
    """Build the worker budget through the single canonical constructor."""
    from .. import agent_run_bundle

    return agent_run_bundle.budget_from_spec(spec)


def _bundle_from_input(inp: AgentRunInput) -> AgentRunBundle:
    spec = parse_spec(inp.agent_spec)
    return AgentRunBundle(
        run_id=inp.run_id,
        objective_id=inp.objective["id"],
        objective=Objective.model_validate(inp.objective),
        agent_spec=spec,
        memory_excerpts=[MemoryExcerpt.model_validate(m) for m in inp.memory_excerpts],
        eval_rubric=inp.eval_rubric,
        budget=_budget_for(spec),
    )


def create_run(inp: AgentRunInput, workflow_id: str) -> dict:
    """Create the run ledger record (called once at workflow start)."""
    meta = inp.agent_spec["metadata"]
    record = RunRecord(
        id=inp.run_id,
        temporal_workflow_id=workflow_id,
        abox_task_id=inp.run_id,
        objective_id=inp.objective["id"],
        agent_ref=f"{meta['name']}@{meta['version']}",
        git_branch=ids.git_branch_for(inp.run_id),
    )
    ledger = DEPS.ledger
    if hasattr(ledger, "create_run"):
        # Pass the objective document so durable ledgers can upsert the
        # objectives row the runs FK points at (TMP-2).
        ledger.create_run(record, objective=inp.objective)
    return {"run_id": record.id, "git_branch": record.git_branch}


def load_agent_spec(name: str, run_id: str | None = None) -> dict | None:
    """Load an agent spec document by name for meta-agent dispatch (TMP-3).

    Prefers the ledger's ACTIVE version — never candidates, rejected, or
    archived versions (design §2, fixes OPT-5). When a canary version exists
    and ``run_id`` is given, ``hash(run_id) % 100 < canary_percent``
    deterministically routes that run to the canary. Falls back to the repo's
    seed ``agents/<name>.yaml``. Returns ``None`` when nothing resolves — the
    workflow dead-letters the objective rather than crashing.
    """
    import yaml

    def _doc(record) -> dict | None:
        try:
            doc = yaml.safe_load(record.spec_yaml)
        except yaml.YAMLError:
            return None
        return doc if isinstance(doc, dict) else None

    ledger = DEPS.ledger
    canary_version = getattr(ledger, "canary_version", None)
    if run_id is not None and callable(canary_version):
        canary = canary_version(name)
        if canary is not None and routes_to_canary(run_id, PromotionPolicy().canary_percent):
            doc = _doc(canary)
            if doc is not None:
                return doc

    active = getattr(ledger, "active_version", None)
    if callable(active):
        record = active(name)
        if record is not None:
            doc = _doc(record)
            if doc is not None:
                return doc

    # Repo seed specs; reject anything that is not a bare agent name.
    if not name or "/" in name or "\\" in name or ".." in name:
        return None
    try:
        path = paths.agents_dir() / f"{name}.yaml"
    except FileNotFoundError:
        # No bundled agents data on this install: same contract as an unknown
        # name — None dead-letters the objective instead of crashing.
        return None
    if not path.is_file():
        return None
    doc = yaml.safe_load(path.read_text())
    return doc if isinstance(doc, dict) else None


def render_bundle(inp: AgentRunInput) -> dict:
    bundle = _bundle_from_input(inp)
    return bundle.model_dump(by_alias=True, mode="json")


def _sandbox_accepts_cancel_event(fn: object) -> bool:
    """Whether a sandbox callable takes a ``cancel_event`` (SEC-5).

    The abox runner and local sandbox do; injected test stubs (``fn(bundle)``)
    do not, so cancellation plumbing is passed only when supported rather than
    breaking a stub with an unexpected kwarg.
    """
    import inspect

    try:
        params = inspect.signature(fn).parameters  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return False
    return "cancel_event" in params or any(
        p.kind == inspect.Parameter.VAR_KEYWORD for p in params.values()
    )


def run_sandbox(bundle_dict: dict, cancel_event: object | None = None) -> dict:
    bundle = AgentRunBundle.model_validate(bundle_dict)
    fn: Any = DEPS.sandbox_fn()
    if cancel_event is not None and _sandbox_accepts_cancel_event(fn):
        outcome = fn(bundle, cancel_event=cancel_event)
    else:
        outcome = fn(bundle)
    return {
        "run_id": outcome.run_id,
        "abox_task_id": outcome.abox_task_id,
        "exit_code": outcome.exit_code,
        "git_branch": outcome.git_branch,
        "result": outcome.result,
        "diff": outcome.diff,
        "changed_files": outcome.changed_files,
        "denied_commands": outcome.denied_commands,
        "runtime_seconds": outcome.runtime_seconds,
        "tokens_used": outcome.tokens_used,
        "observability": outcome.observability,
        "succeeded": outcome.succeeded,
        # Failure breadcrumbs: live cycles were undiagnosable without them.
        "error": outcome.error,
        "stderr": outcome.stderr[-2000:],
    }


# --- Performance measurement and diagnostic profiling ---


def _performance_reason(error: object) -> str:
    """Bound failure text before it crosses the durable workflow boundary."""
    return str(error).strip()[:1_024] or type(error).__name__


def _is_cancelled(cancel_event: object | None) -> bool:
    if cancel_event is None:
        return False
    is_set = getattr(cancel_event, "is_set", None)
    return bool(is_set()) if callable(is_set) else False


class _CancellationAwareInvoker:
    def __init__(self, delegate: WorkloadInvoker, cancel_event: object | None) -> None:
        self._delegate = delegate
        self._cancel_event = cancel_event

    def invoke(
        self,
        workload: LoadedWorkload,
        revision: RevisionPin,
        environment: EnvironmentPin,
        *,
        phase: InvocationPhase,
        ordinal: int,
    ) -> InvocationOutcome:
        if _is_cancelled(self._cancel_event):
            return InvocationOutcome(
                ordinal=ordinal,
                phase=phase,
                status=RecordStatus.cancelled,
                failure_reason=FailureReason.cancelled,
            )
        return self._delegate.invoke(
            workload,
            revision,
            environment,
            phase=phase,
            ordinal=ordinal,
        )


def _performance_result(
    operation_id: str,
    kind: str,
    status: str,
    *,
    record: Any | None = None,
    related_records: dict[str, Any] | None = None,
    reason: str | None = None,
) -> PerformanceWorkflowResult:
    return PerformanceWorkflowResult(
        operation_id=operation_id,
        kind=kind,
        status=status,
        record_id=getattr(record, "id", None),
        record=record.to_dict() if record is not None else None,
        related_records={name: value.to_dict() for name, value in (related_records or {}).items()},
        reason=reason,
    )


def _expected_workload_pin(document: dict[str, Any] | None) -> WorkloadPin | None:
    return WorkloadPin.model_validate(document) if document is not None else None


def _load_performance_workload(
    ref: str,
    *,
    source_location: str | None = None,
    expected_pin: dict[str, Any] | None = None,
) -> LoadedWorkload:
    source = (
        DEPS.performance_workload_source_fn()
        if source_location is None
        else workload_source_from_location(source_location)
    )
    workload = source.load(ref)
    expected = _expected_workload_pin(expected_pin)
    if expected is not None and workload.pin != expected:
        raise WorkloadLoadError(f"loaded workload {ref!r} does not match the immutable request pin")
    return workload


def prepare_performance_optimization(objective_document: dict[str, Any]) -> dict[str, Any]:
    """Resolve filesystem-backed pins outside deterministic workflow code."""

    try:
        objective = Objective.model_validate(objective_document)
        if objective.performance is None:
            raise PerformanceServiceError("optimize objective has no performance contract")
        workload = _load_performance_workload(objective.performance.workload_ref.ref)
        expected_pin = objective.performance.workload_pin
        if expected_pin is not None and workload.pin != expected_pin:
            raise PerformanceServiceError(
                "loaded workload does not match the objective's immutable workload pin"
            )
        DEPS.ledger.record_workload_version(workload.spec, workload.pin)

        direct = Path(objective.repo).expanduser()
        if direct.is_dir():
            repo_path = direct.resolve()
        else:
            registered = DEPS.ledger.get_repo(objective.repo)
            if registered is not None:
                repo_path = Path(registered.path).expanduser().resolve()
            else:
                root = Path(os.environ.get("BAKUDO_REPO_ROOT", Path.cwd())).expanduser()
                candidate = root.resolve() / objective.repo
                repo_path = candidate if candidate.is_dir() else root.resolve()
        revision = pin_repository_revision(
            repo_path,
            repository=objective.repo,
            require_clean=True,
        )
        environment = configured_environment_pin()
        return {
            "status": "completed",
            "workload": workload.ref,
            "workloadSource": durable_workload_source_location(workload),
            "workloadPin": workload.pin.model_dump(by_alias=True, mode="json"),
            "baselineRevision": revision.model_dump(by_alias=True, mode="json"),
            "environment": environment.model_dump(by_alias=True, mode="json"),
        }
    except (
        KeyError,
        OSError,
        ValueError,
        WorkloadLoadError,
        PerformanceServiceError,
    ) as exc:
        return {"status": "invalid", "reason": _performance_reason(exc)}


def prepare_artifact_experiment(spec_document: dict[str, Any]) -> dict[str, Any]:
    """Resolve an artifact experiment's exact workload and environment pins."""
    from ..experiments.models import ExperimentSpec, SoftwareArtifactSubject

    try:
        spec = ExperimentSpec.model_validate(spec_document)
        if not isinstance(spec.subject, SoftwareArtifactSubject):
            raise ValueError("artifact preparation requires a software-artifact subject")
        subject = spec.subject
        workload = _load_performance_workload(subject.workload_ref.ref)
        if workload.provenance.source_kind is not subject.workload_ref.source:
            raise WorkloadLoadError(
                "resolved workload source kind does not match subject.workloadRef"
            )
        if workload.spec.subject.repo != subject.repository:
            raise WorkloadLoadError("resolved workload repository does not match artifact subject")
        DEPS.ledger.record_workload_version(workload.spec, workload.pin)
        environment = configured_environment_pin()
        return {
            "status": "completed",
            "workload": workload.ref,
            "workloadSource": durable_workload_source_location(workload),
            "workloadPin": workload.pin.model_dump(by_alias=True, mode="json"),
            "environment": environment.model_dump(by_alias=True, mode="json"),
        }
    except (KeyError, OSError, ValueError, WorkloadLoadError) as exc:
        return {"status": "invalid", "reason": _performance_reason(exc)}


def analyze_artifact_experiment(input: dict[str, Any]) -> dict[str, Any]:
    """Analyze persisted MeasurementRecord IDs through the artifact binding."""
    from ..experiments.artifact_subject import ArtifactMeasurementRequest, ArtifactSubjectBinding
    from ..experiments.models import ExperimentSpec
    from ..experiments.runner import assemble_observation_result

    spec = ExperimentSpec.model_validate(input["spec"])
    cells: dict[tuple[str, int], str] = {}
    for cell in input["measurements"]:
        key = (str(cell["arm"]), int(cell["repetition"]))
        if key in cells:
            raise ValueError(f"duplicate artifact measurement cell {key!r}")
        cells[key] = str(cell["measurement_id"])

    def measurement_id(request: ArtifactMeasurementRequest) -> str:
        try:
            return cells[(request.arm, request.repetition)]
        except KeyError as exc:
            raise ValueError(
                f"missing artifact measurement cell {(request.arm, request.repetition)!r}"
            ) from exc

    provider = ArtifactSubjectBinding(spec, ledger=DEPS.ledger, measure=measurement_id)
    experiment_id = str(input["experiment_id"])
    batch = provider.collect(experiment_id)
    return assemble_observation_result(spec, provider, batch, experiment_id=experiment_id)


def _measurement_collision(
    existing: Any,
    workload_ref: str,
    workload_pin: WorkloadPin | None,
    revision: RevisionPin,
    environment: EnvironmentPin,
) -> None:
    if (
        existing.workload.ref != workload_ref
        or (workload_pin is not None and existing.workload != workload_pin)
        or existing.revision != revision
        or existing.environment != environment
    ):
        raise PerformanceServiceError(
            f"measurement id {existing.id!r} is already bound to different pins"
        )


def run_performance_measurement(
    inp: PerformanceMeasurementInput,
    cancel_event: object | None = None,
) -> PerformanceWorkflowResult:
    """Load, execute, and durably record one retry-idempotent measurement."""
    kind = "measurement"
    if inp.measurement_id is None:
        raise ValueError("measurement_id must be resolved by the workflow")
    if _is_cancelled(cancel_event):
        return _performance_result(inp.operation_id, kind, RecordStatus.cancelled.value)
    try:
        revision = RevisionPin.model_validate(inp.revision)
        environment = EnvironmentPin.model_validate(inp.environment)
        workload_pin = _expected_workload_pin(inp.workload_pin)
        integrity = IntegrityResult.model_validate(inp.integrity or {})
    except ValueError as exc:
        return _performance_result(
            inp.operation_id,
            kind,
            RecordStatus.invalid_workload.value,
            reason=_performance_reason(exc),
        )

    existing = DEPS.ledger.get_measurement(inp.measurement_id)
    if existing is not None:
        _measurement_collision(existing, inp.workload, workload_pin, revision, environment)
        return _performance_result(inp.operation_id, kind, existing.status.value, record=existing)

    invoker = DEPS.performance_invoker_or_none()
    if invoker is None:
        return _performance_result(
            inp.operation_id,
            kind,
            RecordStatus.unsupported.value,
            reason="performance measurement requires the abox sandbox or an injected invoker",
        )
    try:
        workload = _load_performance_workload(
            inp.workload,
            source_location=inp.workload_source,
            expected_pin=inp.workload_pin,
        )
        record = PerformanceMeasurementService(
            _CancellationAwareInvoker(invoker, cancel_event), ledger=DEPS.ledger
        ).measure(
            workload,
            revision,
            environment,
            integrity=integrity,
            record_id=inp.measurement_id,
        )
    except PerformanceRunnerReadinessError as exc:
        return _performance_result(
            inp.operation_id,
            kind,
            RecordStatus.unsupported.value,
            reason=_performance_reason(exc),
        )
    except (KeyError, WorkloadLoadError, PerformanceServiceError, ValueError) as exc:
        return _performance_result(
            inp.operation_id,
            kind,
            RecordStatus.invalid_workload.value,
            reason=_performance_reason(exc),
        )
    return _performance_result(inp.operation_id, kind, record.status.value, record=record)


def _comparison_collision(
    existing: Any,
    inp: PerformanceComparisonInput,
    workload_pin: WorkloadPin | None,
    baseline_revision: RevisionPin,
    candidate_revision: RevisionPin,
    baseline_environment: EnvironmentPin,
    candidate_environment: EnvironmentPin,
) -> None:
    if (
        existing.workload.ref != inp.workload
        or (workload_pin is not None and existing.workload != workload_pin)
        or existing.baseline_revision != baseline_revision
        or existing.candidate_revision != candidate_revision
        or existing.baseline_environment != baseline_environment
        or existing.candidate_environment != candidate_environment
        or existing.baseline_measurement_id != inp.baseline_measurement_id
        or existing.candidate_measurement_id != inp.candidate_measurement_id
    ):
        raise PerformanceServiceError(
            f"comparison id {existing.id!r} is already bound to different pins"
        )


def run_performance_comparison(
    inp: PerformanceComparisonInput,
    cancel_event: object | None = None,
) -> PerformanceWorkflowResult:
    """Run and persist a fresh interleaved comparison with stable record IDs."""
    kind = "comparison"
    if (
        inp.baseline_measurement_id is None
        or inp.candidate_measurement_id is None
        or inp.comparison_id is None
    ):
        raise ValueError("comparison record IDs must be resolved by the workflow")
    if _is_cancelled(cancel_event):
        return _performance_result(inp.operation_id, kind, RecordStatus.cancelled.value)
    try:
        baseline_revision = RevisionPin.model_validate(inp.baseline_revision)
        candidate_revision = RevisionPin.model_validate(inp.candidate_revision)
        baseline_environment = EnvironmentPin.model_validate(inp.baseline_environment)
        candidate_environment = EnvironmentPin.model_validate(inp.candidate_environment)
        workload_pin = _expected_workload_pin(inp.workload_pin)
        integrity = IntegrityResult.model_validate(inp.integrity or {})
    except ValueError as exc:
        return _performance_result(
            inp.operation_id,
            kind,
            RecordStatus.invalid_workload.value,
            reason=_performance_reason(exc),
        )

    existing = DEPS.ledger.get_performance_comparison(inp.comparison_id)
    if existing is not None:
        _comparison_collision(
            existing,
            inp,
            workload_pin,
            baseline_revision,
            candidate_revision,
            baseline_environment,
            candidate_environment,
        )
        related = {
            name: record
            for name, measurement_id in (
                ("baseline", inp.baseline_measurement_id),
                ("candidate", inp.candidate_measurement_id),
            )
            if (record := DEPS.ledger.get_measurement(measurement_id)) is not None
        }
        return _performance_result(
            inp.operation_id,
            kind,
            existing.status.value,
            record=existing,
            related_records=related,
        )

    candidate_patches = (
        {candidate_revision.patch_digest: inp.candidate_patch}
        if candidate_revision.patch_digest is not None and inp.candidate_patch is not None
        else None
    )
    invoker = DEPS.performance_invoker_or_none(candidate_patches)
    if invoker is None:
        return _performance_result(
            inp.operation_id,
            kind,
            RecordStatus.unsupported.value,
            reason="performance comparison requires the abox sandbox or an injected invoker",
        )
    try:
        workload = _load_performance_workload(
            inp.workload,
            source_location=inp.workload_source,
            expected_pin=inp.workload_pin,
        )
        run = PerformanceMeasurementService(
            _CancellationAwareInvoker(invoker, cancel_event), ledger=DEPS.ledger
        ).compare(
            workload,
            baseline_revision,
            candidate_revision,
            baseline_environment,
            candidate_environment,
            seed=inp.seed,
            primary_metric=inp.primary_metric,
            protected_metrics=tuple(inp.protected_metrics),
            confidence=inp.confidence,
            bootstrap_resamples=inp.bootstrap_resamples,
            integrity=integrity,
            compatibility_policy=CompatibilityPolicy(
                allow_bakudo_patch_difference=inp.allow_bakudo_patch_difference,
                allow_abox_patch_difference=inp.allow_abox_patch_difference,
            ),
            baseline_record_id=inp.baseline_measurement_id,
            candidate_record_id=inp.candidate_measurement_id,
            comparison_id=inp.comparison_id,
        )
    except PerformanceRunnerReadinessError as exc:
        return _performance_result(
            inp.operation_id,
            kind,
            RecordStatus.unsupported.value,
            reason=_performance_reason(exc),
        )
    except (KeyError, WorkloadLoadError, PerformanceServiceError, ValueError) as exc:
        return _performance_result(
            inp.operation_id,
            kind,
            RecordStatus.invalid_workload.value,
            reason=_performance_reason(exc),
        )
    return _performance_result(
        inp.operation_id,
        kind,
        run.comparison.status.value,
        record=run.comparison,
        related_records={"baseline": run.baseline, "candidate": run.candidate},
    )


def run_performance_capture(
    inp: PerformanceCaptureInput,
    cancel_event: object | None = None,
) -> PerformanceWorkflowResult:
    """Run an injected provision-and-profile service and persist its snapshot."""
    kind = "capture"
    if inp.snapshot_id is None:
        raise ValueError("snapshot_id must be resolved by the workflow")
    if _is_cancelled(cancel_event):
        return _performance_result(inp.operation_id, kind, RecordStatus.cancelled.value)
    try:
        revision = RevisionPin.model_validate(inp.revision)
        environment = EnvironmentPin.model_validate(inp.environment)
        workload_pin = _expected_workload_pin(inp.workload_pin)
    except ValueError as exc:
        return _performance_result(
            inp.operation_id,
            kind,
            RecordStatus.invalid_workload.value,
            reason=_performance_reason(exc),
        )

    existing = DEPS.ledger.get_performance_snapshot(inp.snapshot_id)
    if existing is not None:
        if (
            existing.workload.ref != inp.workload
            or (workload_pin is not None and existing.workload != workload_pin)
            or existing.revision != revision
            or existing.environment.model_copy(
                update={"profiler_adapter": None, "profiler_version": None}
            )
            != environment.model_copy(update={"profiler_adapter": None, "profiler_version": None})
            or existing.descriptor.name != inp.profiler
        ):
            raise PerformanceServiceError(
                f"snapshot id {existing.id!r} is already bound to different pins"
            )
        return _performance_result(inp.operation_id, kind, existing.status.value, record=existing)

    capture = DEPS.performance_capture
    if capture is None:
        return _performance_result(
            inp.operation_id,
            kind,
            RecordStatus.unsupported.value,
            reason="diagnostic capture requires an injected provision-and-capture service",
        )
    try:
        workload = _load_performance_workload(
            inp.workload,
            source_location=inp.workload_source,
            expected_pin=inp.workload_pin,
        )
        profiler = next(
            (item for item in workload.spec.profilers if item.name == inp.profiler), None
        )
        if profiler is None:
            return _performance_result(
                inp.operation_id,
                kind,
                RecordStatus.unsupported.value,
                reason=f"workload {inp.workload!r} does not declare profiler {inp.profiler!r}",
            )
        snapshot = capture.capture(
            workload,
            revision,
            environment,
            profiler,
            snapshot_id=inp.snapshot_id,
            cancel_event=cancel_event,
        )
        snapshot = snapshot.model_copy(update={"id": inp.snapshot_id})
        if (
            snapshot.workload != workload.pin
            or snapshot.revision != revision
            or snapshot.environment.model_copy(
                update={"profiler_adapter": None, "profiler_version": None}
            )
            != environment.model_copy(update={"profiler_adapter": None, "profiler_version": None})
            or snapshot.descriptor.name != profiler.name
            or snapshot.descriptor.adapter != profiler.adapter
            or snapshot.environment.profiler_adapter != profiler.adapter
            or snapshot.environment.profiler_version != snapshot.descriptor.version
        ):
            raise PerformanceServiceError("capture service returned evidence for different pins")
        DEPS.ledger.record_performance_snapshot(snapshot)
    except ProfilerUnsupportedError as exc:
        return _performance_result(
            inp.operation_id,
            kind,
            RecordStatus.unsupported.value,
            reason=_performance_reason(exc),
        )
    except (TimeoutError, ProfileTimeoutError) as exc:
        return _performance_result(
            inp.operation_id,
            kind,
            RecordStatus.timed_out.value,
            reason=_performance_reason(exc),
        )
    # ProfileCaptureError last: it is the base of the typed arms above, so it
    # sweeps up the remaining deterministic capture-binding failures (for
    # example a fresh-abox binding rejection) instead of letting Temporal
    # retry them as opaque activity errors.
    except (ProfileExecutionError, ProfileCaptureError) as exc:
        return _performance_result(
            inp.operation_id,
            kind,
            RecordStatus.failed.value,
            reason=_performance_reason(exc),
        )
    except (KeyError, WorkloadLoadError, PerformanceServiceError, ValueError) as exc:
        return _performance_result(
            inp.operation_id,
            kind,
            RecordStatus.invalid_workload.value,
            reason=_performance_reason(exc),
        )
    return _performance_result(inp.operation_id, kind, snapshot.status.value, record=snapshot)


def persist_run(run_id: str, phase: str, payload: dict) -> None:
    """Advance a run's phase in whichever ledger is configured.

    Backend-agnostic: both the in-memory and Postgres ledgers implement the
    same sync :class:`~bakudo.registry.ledger.Ledger` Protocol.
    """
    ledger = DEPS.ledger
    ph = RunPhase(phase)
    try:
        if ph.is_terminal:
            ledger.finish_run(run_id, ph, payload.get("result"))
        else:
            ledger.set_phase(run_id, ph)
    except KeyError:
        # Run record not present yet (e.g. created event raced); safe to skip.
        pass


def run_eval_suite(inp: EvalInput) -> dict:
    ctx = EvalContext(
        result=RunResult.model_validate(inp.result),
        objective=Objective.model_validate(inp.objective),
        diff=inp.diff,
        denied_commands=inp.denied_commands,
        runtime_seconds=inp.runtime_seconds,
        tokens_used=inp.tokens_used,
        schema_valid=inp.schema_valid,
    )
    # Unified assembly (TMP-22): the objective-type-aware base suite plus the
    # sandboxed critic (design §5, OPT-8) — reviewed by a real read-only agent
    # through the same sandbox driver as the run. With no sandbox available
    # (offline/dev) the critic is omitted and a policy requiring `critic` fails
    # loudly at decision time. The Temporal path is the only one that runs with
    # a live sandbox, hence the only one that assembles the critic.
    try:
        critic_sandbox: SandboxFn | None = DEPS.sandbox_fn()
    except RuntimeError:
        critic_sandbox = None
    results = assemble_suite(ctx, sandbox=critic_sandbox, with_critic=True)

    scorecard = Scorecard.from_results(results)
    record_eval = getattr(DEPS.ledger, "record_eval", None)
    if callable(record_eval):
        for r in results:
            record_eval(r)
    return {
        "eval_results": [r.to_dict() for r in results],
        "scorecard": scorecard.model_dump(mode="json"),
    }


def decide_promotion(inp: PromotionInput) -> dict:
    candidate = Scorecard.model_validate(inp.candidate)
    baseline = Scorecard.model_validate(inp.baseline) if inp.baseline else None
    decision = decide(
        candidate,
        baseline,
        policy=PromotionPolicy(),
        mutation_kinds=inp.mutation_kinds,
    )
    # Record + transition the candidate version through the §1 state machine.
    apply_decision(DEPS.ledger, decision)
    return decision.to_dict()


def _window_stats(ledger: Ledger, runs: list) -> dict | None:
    """Aggregate scorecard stats over a window of completed runs.

    Runs whose eval results were never recorded are skipped; returns ``None``
    when nothing is measurable.
    """
    scores: list[float] = []
    safety_regressions = 0
    critical_failures = 0
    for run in runs:
        results = ledger.eval_results(run.id)
        if not results:
            continue
        card = Scorecard.from_results(results)
        scores.append(card.overall_score)
        safety_regressions += card.safety_regressions
        critical_failures += card.critical_failures
    if not scores:
        return None
    return {
        "mean_score": sum(scores) / len(scores),
        "runs": len(scores),
        "safety_regressions": safety_regressions,
        "critical_failures": critical_failures,
    }


def check_canary_graduation(name: str) -> dict:
    """Graduate or roll back a canary version after a finished run (design §3).

    Invoked from AgentRunWorkflow's completion path; the workflow stays
    deterministic because every read/compare/transition happens here, ledger-
    side. Once the canary has ``policy.canary.minRuns`` completed runs, its
    mean ``overall_score`` and hard counters (safety_regressions == 0,
    critical_failures == 0) are compared against the active version's trailing
    runs over the same window: better-or-equal graduates (canary -> active,
    old active -> archived), worse rolls back (canary -> rejected). Every
    transition is a ledger write with an event, plus a recorded decision.
    """
    from datetime import UTC, datetime

    from ..evals.promotion import Decision, PromotionDecision

    ledger = DEPS.ledger
    policy = PROMOTION_POLICY

    canary_version = getattr(ledger, "canary_version", None)
    if not callable(canary_version):
        return {"status": "no-canary", "agent": name}
    canary = canary_version(name)
    if canary is None:
        return {"status": "no-canary", "agent": name}

    canary_ref = f"{name}@{canary.version}"
    window = policy.canary_min_runs
    canary_runs = ledger.completed_runs(canary_ref, limit=window)
    if len(canary_runs) < window:
        return {
            "status": "insufficient-runs",
            "agent": canary_ref,
            "runs": len(canary_runs),
            "required": window,
        }
    canary_stats = _window_stats(ledger, canary_runs)
    if canary_stats is None or canary_stats["runs"] < window:
        return {
            "status": "insufficient-runs",
            "agent": canary_ref,
            "runs": 0 if canary_stats is None else canary_stats["runs"],
            "required": window,
        }

    active = ledger.active_version(name)
    active_stats = None
    if active is not None:
        active_stats = _window_stats(
            ledger, ledger.completed_runs(f"{name}@{active.version}", limit=window)
        )
    baseline_mean = active_stats["mean_score"] if active_stats else None

    card = Scorecard(
        subject_type="agent_spec_version",
        subject_id=canary_ref,
        overall_score=max(0.0, min(1.0, canary_stats["mean_score"])),
        safety_regressions=canary_stats["safety_regressions"],
        critical_failures=canary_stats["critical_failures"],
        cases_total=canary_stats["runs"],
    )

    hard_failure = canary_stats["safety_regressions"] > 0 or canary_stats["critical_failures"] > 0
    worse = baseline_mean is not None and canary_stats["mean_score"] < baseline_mean

    if hard_failure or worse:
        reason = (
            f"canary rollback: safety_regressions="
            f"{canary_stats['safety_regressions']}, critical_failures="
            f"{canary_stats['critical_failures']}"
            if hard_failure
            else (
                f"canary rollback: mean score {canary_stats['mean_score']:.3f} "
                f"below active baseline {baseline_mean:.3f}"
            )
        )
        # Same compare-and-set guard as graduation (TMP-23): only the first
        # finisher rolls the canary back; a concurrent second is a no-op.
        rolled = ledger.set_version_status(
            name, canary.version, "rejected", reason=reason, expected_status="canary"
        )
        if rolled is None:
            return {"status": "already-resolved", "agent": canary_ref}
        ledger.record_promotion(
            PromotionDecision(
                Decision.reject,
                reason,
                card,
                status="rejected",
                approved_by="canary-graduation",
                resolved_at=datetime.now(UTC),
            )
        )
        return {"status": "rolled-back", "agent": canary_ref, "reason": reason}

    reason = (
        f"canary graduated: mean score {canary_stats['mean_score']:.3f} over "
        f"{canary_stats['runs']} runs"
        + (
            f" >= active baseline {baseline_mean:.3f}"
            if baseline_mean is not None
            else " with no active baseline runs"
        )
    )
    # Compare-and-set on the canary status (TMP-23): two runs finishing near-
    # simultaneously both reach here, but only the first flips canary->active;
    # the second's guarded transition is a no-op (returns None) and it bails
    # without double-archiving the old active or recording a duplicate promotion.
    graduated = ledger.set_version_status(
        name, canary.version, "active", reason=reason, expected_status="canary"
    )
    if graduated is None:
        return {"status": "already-resolved", "agent": canary_ref}
    if active is not None:
        ledger.set_version_status(
            name,
            active.version,
            "archived",
            reason=f"superseded by {canary_ref}",
        )
    ledger.record_promotion(
        PromotionDecision(
            Decision.promote,
            reason,
            card,
            status="approved",
            approved_by="canary-graduation",
            resolved_at=datetime.now(UTC),
        )
    )
    return {"status": "graduated", "agent": canary_ref, "reason": reason}


def _task_case_run_fn(spec: AgentSpec, objective: Objective, source: TaskSource) -> CaseRun:
    """Run one task-backed eval case through the trial substrate."""
    from ..evals.corpus import task_run_fn
    from ..trials.runner import build_pipeline_fn

    def sandbox_fn(bundle: AgentRunBundle, repo_path: Path) -> AboxOutcome:
        return DEPS.sandbox_fn()(bundle)

    run = task_run_fn(
        source=source,
        verifier_runner=DEPS.verifier_eval_fn,
        pipeline_factory=lambda: build_pipeline_fn(
            spec, sandbox_fn=sandbox_fn, run_objective_fn=DEPS.run_objective_fn
        ),
    )
    return run(objective)


def run_agent_evolution(inp: EvolutionInput) -> dict:
    """Score a candidate spec against a baseline over benchmark tasks (§15)."""
    baseline = parse_spec(inp.baseline_spec)
    candidate = parse_spec(inp.candidate_spec)
    source = DEPS.task_source_fn()
    cases = load_corpus_from_tasks(families=["debugging", "no-change"], source=source)

    def run_fn(spec: AgentSpec, objective: Objective) -> CaseRun:
        return _task_case_run_fn(spec, objective, source)

    outcome = evolve_agent(baseline, candidate, cases, run_fn)

    if callable(getattr(DEPS.ledger, "record_promotion", None)):
        # Record + transition the candidate version (design §1/§4).
        apply_decision(DEPS.ledger, outcome.decision)
    return {
        "decision": outcome.decision.to_dict(),
        "baseline_scorecard": outcome.baseline.model_dump(mode="json"),
        "candidate_scorecard": outcome.candidate.model_dump(mode="json"),
    }


def compact_memories(inp: CompactionInput) -> dict:
    """Compact a run's emitted memories into the durable store (§14, §10.1)."""
    result = RunResult.model_validate(inp.result)
    report = compact(result, DEPS.memory, repo=inp.repo)
    return {"written": report.written, "rejected": report.rejected}


_TERMINAL_RUN_PHASES = {"completed", "failed", "cancelled", "archived"}


def reconcile_runs(run_ids: list[str]) -> list[str]:
    """Return the run ids whose ledger record is already terminal (TMP-18).

    The meta-agent uses this to free concurrency slots held by runs that
    finished but whose ``run_completed`` signal was lost — reconciling against
    the authoritative terminal *status*, so a genuinely still-running child
    (its ledger phase is non-terminal) is never dropped. A run with no ledger
    record yet is left alone here (it may be mid-dispatch); the meta-agent's
    coarse time-TTL is the backstop for a record that never appears.
    """
    ledger = DEPS.ledger
    done: list[str] = []
    for run_id in run_ids:
        run = ledger.get_run(run_id)
        if run is not None and run.phase.value in _TERMINAL_RUN_PHASES:
            done.append(run_id)
    return done


def collect_signals(inp: ObserveInput) -> list[dict]:
    """Collect repo signals and emit candidate objectives (§16.1).

    Uses the injected collector, or one assembled from environment config
    (``BAKUDO_REPO_PATH``, ``BAKUDO_COVERAGE_XML``, ``BAKUDO_JUNIT_XML``,
    ``GITHUB_TOKEN``). Returns an empty backlog when nothing is configured,
    rather than guessing.
    """
    collector = DEPS.collector or build_default_collector(inp.repo)
    if collector is None:
        return []
    signals = collector.collect(inp.repo)
    return [obj.to_dict() for obj in generate_objectives(signals)]


# --- Experiment substrate (Task 11): trial/experiment activities ---
#
# select_tasks/the task source read the filesystem, so per
# controller ruling R1 they may never run in workflow code -- every task/
# agent-spec file I/O below is an activity. ExperimentWorkflow/TrialWorkflow
# build the deterministic trial matrix themselves from the plain descriptor
# dicts these activities return, using only the pure
# bakudo.experiments.design.trial_seed helper.


def resolve_experiment_tasks(input: dict) -> dict:
    """Resolve an ExperimentSpec's task selection AND its arm refs.

    Runs :func:`bakudo.experiments.design.select_tasks` (task-source file
    I/O) so ``ExperimentWorkflow`` never has to (R1), and resolves every arm
    ref (``spec.subject.baseline`` + ``spec.subject.candidates``) the same on-disk,
    pinned-version-checked way :func:`provision_trial`
    (``_resolve_trial_agent_spec``) does. Returns
    ``{"tasks": [descriptor, ...], "resolvedArms": {raw_ref: resolved_ref}}``.

    The arm resolution matters beyond labelling: every ``TrialRecord`` a
    ``TrialWorkflow`` child records carries the RESOLVED ref (whatever
    ``provision_trial``/``_resolve_trial_agent_spec`` actually loaded off
    disk), so if ``ExperimentWorkflow`` built its trial matrix and handed
    ``analyze_experiment`` the RAW (possibly unpinned) subject baseline/
    candidates instead, every ``TrialRecord.agent_ref`` lookup
    comparison inside :func:`bakudo.experiments.runner.assemble_result`
    would silently fail to match and zero every statistic. Resolving once,
    here, keeps the trial matrix's arms and the spec ``analyze_experiment``/
    the persisted experiment row carry in lockstep with what actually ran.
    """
    from ..experiments.design import select_tasks
    from ..experiments.models import AgentSpecSubject, ExperimentSpec

    spec = ExperimentSpec.model_validate(input["spec"])
    if not isinstance(spec.subject, AgentSpecSubject):
        raise TypeError("task resolution requires an agent-spec experiment subject")
    subject = spec.subject
    source = DEPS.task_source_fn()
    tasks = select_tasks(source, spec)
    descriptors = [
        {
            "name": s.spec.metadata.name,
            "version": s.spec.metadata.version,
            "task_pin": s.pin.model_dump(mode="json"),
            "family": s.spec.metadata.family.value,
            "paired_task": s.spec.metadata.paired_task,
        }
        for s in tasks
    ]

    resolved_arms: dict[str, str] = {}
    for raw_ref in (subject.baseline, *subject.candidates):
        if raw_ref in resolved_arms:
            continue
        resolved_arms[raw_ref] = _resolve_trial_agent_spec(raw_ref).ref

    return {"tasks": descriptors, "resolvedArms": resolved_arms}


def _resolve_trial_agent_spec(agent_ref: str) -> AgentSpec:
    """Load an arm's AgentSpec straight off disk, pinned-version-checked.

    Same contract as ``bakudo trial run``/``resolve_arm_pipeline_fn``
    (:mod:`bakudo.experiments.runner`): every arm resolves from
    ``agents_dir()/<name>.yaml``, and an ``@version`` pin that doesn't match
    what's on disk is a hard error -- a trial must never silently claim a
    version it didn't actually run.
    """
    from ..agent_spec import load_spec_file

    name, sep, version_s = agent_ref.partition("@")
    agent_spec = load_spec_file(paths.agents_dir() / f"{name}.yaml")
    if sep:
        try:
            requested_version = int(version_s)
        except ValueError as exc:
            raise ValueError(
                f"invalid agent version in {agent_ref!r}: {version_s!r} is not an integer"
            ) from exc
        if agent_spec.metadata.version != requested_version:
            raise ValueError(
                f"agent spec file for {name!r} is at version "
                f"{agent_spec.metadata.version}, but arm {agent_ref!r} requested "
                f"version {requested_version}"
            )
    return agent_spec


def provision_trial(input: dict) -> dict:
    """Provision a task's fixture workspace and derive its Objective.

    Mirrors ``run_trial``'s setup half (:mod:`bakudo.trials.runner`) plus
    ``resolve_arm_pipeline_fn``'s spec loading, folded into one activity
    since both are filesystem-bound: resolves the task (by ref/bare
    name) and the agent spec (pinned, off-disk) via the task source/agents_dir,
    provisions the task into a fresh scratch workspace, derives the
    Objective, and intersects the task's budget/network ceiling against
    the agent spec's own (tighten-only, same as ``build_pipeline_fn``) into
    an adjusted agent-spec document ready for ``AgentRunWorkflow``.

    NOTE: the scratch workspace is intentionally NOT cleaned up here (unlike
    ``run_trial``'s ``TemporaryDirectory`` context manager) -- it must
    outlive this activity call across the sandbox run and verifier-eval
    activities that follow in the same TrialWorkflow, which may execute on a
    different worker thread. Left for the OS temp reaper, matching how
    sandbox-side worktrees are not explicitly swept either.
    """
    from ..agent_spec.models import NetworkMode, SpecBudget
    from ..trials.runner import intersect_budgets, intersect_network, objective_from_task

    source = DEPS.task_source_fn()
    task = source.get(input["task"])
    agent_spec = _resolve_trial_agent_spec(input["agent"])

    tmp_root = Path(tempfile.mkdtemp(prefix="bakudo-trial-"))
    ws = provision(task, tmp_root, seed=input["seed"])
    objective = objective_from_task(task, ws.repo_path)

    merged_budget = intersect_budgets(agent_spec.budget, task.spec.limits)
    merged_network = intersect_network(
        agent_spec.sandbox.network_mode.value, task.spec.environment.network
    )

    budget_updates: dict[str, Any] = (
        dict(agent_spec.budget.model_dump()) if agent_spec.budget else {}
    )
    if "tokens" in merged_budget:
        budget_updates["max_tokens"] = merged_budget["tokens"]
    if "tool_calls" in merged_budget:
        budget_updates["max_tool_calls"] = merged_budget["tool_calls"]
    timeout_seconds = agent_spec.sandbox.timeout_seconds
    if "wall_seconds" in merged_budget:
        timeout_seconds = min(timeout_seconds, merged_budget["wall_seconds"])

    adjusted_spec = agent_spec.model_copy(
        update={
            "sandbox": agent_spec.sandbox.model_copy(
                update={
                    "network_mode": NetworkMode(merged_network),
                    "timeout_seconds": timeout_seconds,
                }
            ),
            "budget": SpecBudget(**budget_updates) if budget_updates else agent_spec.budget,
        }
    )

    return {
        "repo_path": str(ws.repo_path),
        "objective": objective.to_dict(),
        # AgentSpec.to_dict() (exclude_none=True) -- a bare model_dump would
        # serialize every unset-optional field as JSON null, which the
        # schema rejects for typed fields like budget/maxUsd or
        # tools[].policy (bakudo.schema.validate_agent_spec, invoked by
        # parse_spec inside render_bundle).
        "agent_spec": adjusted_spec.to_dict(),
        "agent_ref": agent_spec.ref,
        "task_pin": task.pin.model_dump(mode="json"),
        "limits": task.spec.limits.model_dump(mode="json"),
        "network": task.spec.environment.network,
        # Runtime pins are separate from the immutable TaskPin. Built here (not in
        # workflow code) since it needs the resolved AgentSpec object.
        "runtime_pins": {
            "bakudo": bakudo_version,
            "model_id": adjusted_spec.model.model_id,
            "sandbox_profile": adjusted_spec.sandbox.profile,
        },
        "timeout_seconds": timeout_seconds,
    }


def evaluate_trial_verifier(input: dict) -> dict:
    """Grade a trial's collected diff against its task's verifier tests.

    Mirrors ``run_trial``'s grading tail (:mod:`bakudo.trials.runner`):
    :func:`bakudo.trials.verifier.evaluate` plus :func:`compute_integrity_flags` and
    the expected/actual status comparison, all folded in here since they
    require the task (task-source I/O) that workflow code may not
    load itself (R1). Uses ``Deps.verifier_eval_fn`` -- fails closed outside
    ``BAKUDO_ENV=dev``/``BAKUDO_SANDBOX=abox`` (see
    :data:`VERIFIER_EVAL_REMEDIATION`).
    """
    from ..trials import verifier
    from ..trials.runner import compute_integrity_flags

    source = DEPS.task_source_fn()
    task = source.get(input["task"])
    runner: VerifierRunner = DEPS.verifier_eval_fn

    outcome = verifier.evaluate(task, input.get("diff") or "", input["seed"], runner)
    integrity = compute_integrity_flags(
        input.get("changed_files") or [],
        input.get("denied_commands") or [],
        task.spec.constraints,
    )
    actual_status = input.get("actual_status")
    expected_status = task.spec.constraints.expected_status
    return {
        "f2p_rate": outcome.f2p_rate,
        "p2p_rate": outcome.p2p_rate,
        "reward": outcome.reward,
        "detail": outcome.detail,
        "expected_status": expected_status,
        "actual_status": actual_status,
        "status_match": actual_status == expected_status,
        "integrity": integrity.model_dump(),
    }


def persist_trial(record: dict) -> None:
    """Record an (immutable) TrialRecord (experiment substrate design doc
    section 6). Idempotent (F4 fix): ``ledger.record_trial`` treats a
    duplicate id as a no-op rather than raising, so a Temporal at-least-once
    retry of this activity (e.g. after a lost activity completion wedges
    ``TrialWorkflow``, and ``ExperimentWorkflow`` separately synthesizes a
    failed record for the same trial) can never double-count a trial's
    stats."""
    trial = TrialRecord.model_validate(record)
    DEPS.ledger.record_trial(trial)


def persist_experiment(input: dict) -> None:
    """Record or update an experiment row (experiment substrate design doc
    section 7). ``status="running"`` records the initial row (idempotent);
    any other status updates it to its terminal result, mirroring
    ``run_experiment``'s ``record_experiment``/``update_experiment_result``
    calls."""
    ledger = DEPS.ledger
    status = input["status"]
    if status == "running":
        ledger.record_experiment(
            input["experiment_id"],
            input["name"],
            input["subject_kind"],
            input["spec"],
            status,
        )
    else:
        ledger.update_experiment_result(input["experiment_id"], status, input.get("result") or {})


def analyze_experiment(input: dict) -> dict:
    """Assemble the experiment result over its recorded trials (Task 10's
    :func:`bakudo.experiments.runner.assemble_result`), fetching trials from
    the ledger rather than threading every ``TrialRecord`` back through the
    workflow -- ``ExperimentWorkflow`` already persisted each one via
    ``persist_trial`` (or, for a crashed child, a synthesized failed record)
    before calling this.
    """
    from ..experiments.models import ExperimentSpec
    from ..experiments.runner import assemble_result

    spec = ExperimentSpec.model_validate(input["spec"])
    task_source = DEPS.task_source_fn()
    trials = DEPS.ledger.list_trials(input["experiment_id"])
    tasks = [task_source.get(f"{d['name']}@{d['version']}") for d in input["tasks"]]
    return assemble_result(spec, trials, tasks=tasks, task_source=task_source)
