"""Deterministic pin-compatibility policy and mismatch reporting."""

from __future__ import annotations

from dataclasses import dataclass

from .models import MeasurementRecord
from .pins import EnvironmentPin, WorkloadPin


@dataclass(frozen=True)
class CompatibilityPolicy:
    """Explicitly allowed environment differences.

    Exact compatibility is the default.  Every relaxation is named and is
    recorded in the report so a comparison never silently crosses execution
    environments.
    """

    allow_bakudo_patch_difference: bool = False
    allow_abox_patch_difference: bool = False


@dataclass(frozen=True)
class CompatibilityReport:
    compatible: bool
    mismatches: tuple[str, ...]
    allowed_differences: tuple[str, ...] = ()


def _major_minor(value: str) -> tuple[str, str] | None:
    pieces = value.split(".")
    return (pieces[0], pieces[1]) if len(pieces) >= 2 else None


def compare_workload_pins(baseline: WorkloadPin, candidate: WorkloadPin) -> tuple[str, ...]:
    if baseline == candidate:
        return ()
    fields = (
        "source_uri",
        "source_kind",
        "collection_revision",
        "name",
        "version",
        "manifest_digest",
        "dataset_digests",
        "executor_digests",
        "bundle_digest",
    )
    return tuple(
        f"workload.{field}: {getattr(baseline, field)!r} != {getattr(candidate, field)!r}"
        for field in fields
        if getattr(baseline, field) != getattr(candidate, field)
    )


def compare_environment_pins(
    baseline: EnvironmentPin,
    candidate: EnvironmentPin,
    policy: CompatibilityPolicy | None = None,
) -> CompatibilityReport:
    policy = policy or CompatibilityPolicy()
    ignored: set[str] = set()
    allowed: list[str] = []
    if (
        policy.allow_bakudo_patch_difference
        and baseline.bakudo_version != candidate.bakudo_version
        and _major_minor(baseline.bakudo_version) == _major_minor(candidate.bakudo_version)
    ):
        ignored.add("bakudo_version")
        allowed.append(
            f"environment.bakudo_version: {baseline.bakudo_version!r} != "
            f"{candidate.bakudo_version!r} (allowed patch difference)"
        )
    if (
        policy.allow_abox_patch_difference
        and baseline.abox_version != candidate.abox_version
        and _major_minor(baseline.abox_version) == _major_minor(candidate.abox_version)
    ):
        ignored.add("abox_version")
        allowed.append(
            f"environment.abox_version: {baseline.abox_version!r} != "
            f"{candidate.abox_version!r} (allowed patch difference)"
        )

    fields = tuple(EnvironmentPin.model_fields)
    mismatches = tuple(
        f"environment.{field}: {getattr(baseline, field)!r} != {getattr(candidate, field)!r}"
        for field in fields
        if field not in ignored and getattr(baseline, field) != getattr(candidate, field)
    )
    return CompatibilityReport(not mismatches, mismatches, tuple(allowed))


def compare_measurement_pins(
    baseline: MeasurementRecord,
    candidate: MeasurementRecord,
    policy: CompatibilityPolicy | None = None,
) -> CompatibilityReport:
    workload_mismatches = compare_workload_pins(baseline.workload, candidate.workload)
    environment = compare_environment_pins(baseline.environment, candidate.environment, policy)
    plan_mismatches = (
        (
            f"plan_digest: {baseline.plan_digest!r} != {candidate.plan_digest!r}",
        )
        if baseline.plan_digest != candidate.plan_digest
        else ()
    )
    mismatches = tuple(
        sorted((*workload_mismatches, *environment.mismatches, *plan_mismatches))
    )
    return CompatibilityReport(not mismatches, mismatches, environment.allowed_differences)
