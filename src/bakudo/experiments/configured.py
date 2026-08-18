"""Production composition for synchronous software-artifact experiments."""

from __future__ import annotations

from typing import Any

from .. import ids
from ..abox.measurement import AboxWorkloadInvoker
from ..performance.environment import configured_environment_pin
from ..performance.models import EnvironmentPin, canonical_digest
from ..performance.service import PerformanceMeasurementService, WorkloadInvoker
from ..performance.source import WorkloadSource, default_workload_source
from .artifact_subject import ArtifactMeasurementObserver, ArtifactMeasurementRequest
from .models import ExperimentSpec, SoftwareArtifactSubject


def configured_artifact_measurement_observer(
    spec: ExperimentSpec,
    *,
    ledger: Any,
    workload_source: WorkloadSource | None = None,
    environment: EnvironmentPin | None = None,
    invoker: WorkloadInvoker | None = None,
) -> ArtifactMeasurementObserver:
    """Compose the artifact experiment port from independently testable services.

    The returned observer is idempotent per experiment cell and always uses the
    exact subject revision.  Production defaults execute each invocation in a
    fresh abox guest; tests can inject only the invoker or environment they need.
    """

    if not isinstance(spec.subject, SoftwareArtifactSubject):
        raise TypeError("artifact measurement composition requires a software-artifact subject")
    subject = spec.subject
    source = workload_source or default_workload_source()
    workload = source.load(subject.workload_ref.ref)
    if workload.provenance.source_kind is not subject.workload_ref.source:
        raise ValueError("resolved workload source kind does not match subject.workloadRef")
    if workload.spec.subject.repo != subject.repository:
        raise ValueError("resolved workload repository does not match artifact subject")

    pinned_environment = environment or configured_environment_pin()
    ledger.record_workload_version(workload.spec, workload.pin)
    service = PerformanceMeasurementService(
        invoker or AboxWorkloadInvoker(),
        ledger=ledger,
    )

    def observe(request: ArtifactMeasurementRequest):
        if request.repository != subject.repository or request.workload != subject.workload_ref:
            raise ValueError("artifact measurement request does not match experiment subject")
        record_id = ids.deterministic_id(
            "measurement",
            ":".join(
                (
                    request.experiment_id,
                    request.arm,
                    str(request.repetition),
                    canonical_digest(request.revision),
                )
            ),
        )
        existing = ledger.get_measurement(record_id)
        if existing is not None:
            return existing.id
        return service.measure(
            workload,
            request.revision,
            pinned_environment,
            record_id=record_id,
        )

    return observe
