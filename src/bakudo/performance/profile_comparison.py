"""Deterministic, diagnostic-only comparison of normalized profile snapshots.

The report in this module explains a performance comparison; it is never a
``PerformanceComparison`` and carries no promotion eligibility.  Its inputs
are normalized snapshot summaries rather than raw profile artifacts, so the
result is safe to present to an operator with the same visibility constraints
as its input snapshots.
"""

from __future__ import annotations

import math
from enum import Enum

from pydantic import BaseModel, ConfigDict, Field, field_validator

from .models import Hotspot, HotspotKind, PerformanceSnapshot, RecordStatus


class ProfileComparisonError(ValueError):
    """Raised when a diagnostic profile comparison cannot be constructed."""


class HotspotChange(str, Enum):
    new = "new"
    removed = "removed"
    increased = "increased"
    decreased = "decreased"
    unchanged = "unchanged"


class _StrictFrozen(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)


class DifferentialHotspot(_StrictFrozen):
    """One stable hotspot aligned between diagnostic baseline and candidate."""

    stable_key: str = Field(alias="stableKey", min_length=1, max_length=512)
    label: str = Field(min_length=1, max_length=512)
    kind: HotspotKind
    baseline_inclusive_cost: float = Field(alias="baselineInclusiveCost", ge=0)
    candidate_inclusive_cost: float = Field(alias="candidateInclusiveCost", ge=0)
    inclusive_delta: float = Field(alias="inclusiveDelta")
    inclusive_relative_delta: float | None = Field(default=None, alias="inclusiveRelativeDelta")
    baseline_exclusive_cost: float | None = Field(default=None, alias="baselineExclusiveCost", ge=0)
    candidate_exclusive_cost: float | None = Field(
        default=None, alias="candidateExclusiveCost", ge=0
    )
    baseline_sample_count: int = Field(alias="baselineSampleCount", ge=0)
    candidate_sample_count: int = Field(alias="candidateSampleCount", ge=0)
    change: HotspotChange

    @field_validator(
        "baseline_inclusive_cost",
        "candidate_inclusive_cost",
        "inclusive_delta",
        "inclusive_relative_delta",
        "baseline_exclusive_cost",
        "candidate_exclusive_cost",
    )
    @classmethod
    def finite_values(cls, value: float | None) -> float | None:
        if value is not None and not math.isfinite(value):
            raise ValueError("must be finite")
        return value


class DifferentialProfileReport(_StrictFrozen):
    """Aligned hotspot deltas, explicitly excluded from statistical evidence."""

    kind: str = "DiagnosticProfileComparison"
    baseline_snapshot_id: str = Field(alias="baselineSnapshotId", min_length=1)
    candidate_snapshot_id: str = Field(alias="candidateSnapshotId", min_length=1)
    comparable: bool
    incompatibilities: tuple[str, ...] = Field(default_factory=tuple, max_length=32)
    hotspots: tuple[DifferentialHotspot, ...] = Field(default_factory=tuple, max_length=1_000)
    diagnostic_only: bool = Field(default=True, alias="diagnosticOnly")


def _snapshot_incompatibilities(
    baseline: PerformanceSnapshot, candidate: PerformanceSnapshot
) -> tuple[str, ...]:
    reasons: list[str] = []
    if baseline.status is not RecordStatus.completed:
        reasons.append(f"baseline snapshot is {baseline.status.value}")
    if candidate.status is not RecordStatus.completed:
        reasons.append(f"candidate snapshot is {candidate.status.value}")
    if baseline.workload != candidate.workload:
        reasons.append("workload pins differ")
    if baseline.environment != candidate.environment:
        reasons.append("environment pins differ")
    if baseline.profiler_spec_digest != candidate.profiler_spec_digest:
        reasons.append("profiler specification digests differ")
    if baseline.descriptor != candidate.descriptor:
        reasons.append("profiler descriptors differ")
    return tuple(reasons)


def _hotspots_by_key(snapshot: PerformanceSnapshot, side: str) -> dict[str, Hotspot]:
    rows: dict[str, Hotspot] = {}
    for hotspot in snapshot.hotspots:
        if hotspot.stable_key in rows:
            raise ProfileComparisonError(f"{side} snapshot contains duplicate hotspot key")
        rows[hotspot.stable_key] = hotspot
    return rows


def _change(baseline_cost: float, candidate_cost: float) -> HotspotChange:
    if baseline_cost == 0 and candidate_cost > 0:
        return HotspotChange.new
    if candidate_cost == 0 and baseline_cost > 0:
        return HotspotChange.removed
    if candidate_cost > baseline_cost:
        return HotspotChange.increased
    if candidate_cost < baseline_cost:
        return HotspotChange.decreased
    return HotspotChange.unchanged


def _delta(
    baseline: Hotspot | None, candidate: Hotspot | None, stable_key: str
) -> DifferentialHotspot:
    exemplar = candidate or baseline
    if exemplar is None:  # pragma: no cover - callers only pass a union key
        raise ProfileComparisonError(f"missing baseline and candidate hotspot for {stable_key}")
    if (
        baseline
        and candidate
        and (baseline.label != candidate.label or baseline.kind != candidate.kind)
    ):
        raise ProfileComparisonError(f"stable hotspot key collision for {stable_key}")

    baseline_inclusive = baseline.inclusive_cost if baseline else 0.0
    candidate_inclusive = candidate.inclusive_cost if candidate else 0.0
    inclusive_delta = candidate_inclusive - baseline_inclusive
    relative = inclusive_delta / baseline_inclusive if baseline_inclusive else None
    if not math.isfinite(inclusive_delta) or (relative is not None and not math.isfinite(relative)):
        raise ProfileComparisonError(f"non-finite diagnostic delta for {stable_key}")
    return DifferentialHotspot(
        stable_key=stable_key,
        label=exemplar.label,
        kind=exemplar.kind,
        baseline_inclusive_cost=baseline_inclusive,
        candidate_inclusive_cost=candidate_inclusive,
        inclusive_delta=inclusive_delta,
        inclusive_relative_delta=relative,
        baseline_exclusive_cost=baseline.exclusive_cost if baseline else None,
        candidate_exclusive_cost=candidate.exclusive_cost if candidate else None,
        baseline_sample_count=baseline.sample_count if baseline else 0,
        candidate_sample_count=candidate.sample_count if candidate else 0,
        change=_change(baseline_inclusive, candidate_inclusive),
    )


def compare_profile_snapshots(
    baseline: PerformanceSnapshot,
    candidate: PerformanceSnapshot,
    *,
    max_hotspots: int = 100,
) -> DifferentialProfileReport:
    """Align diagnostic hotspots for two snapshots with compatible capture pins.

    A non-comparable report is still returned for operators to inspect, but it
    contains no deltas.  Callers must never use either outcome as quantitative
    performance evidence; ``compare_measurements`` owns that decision path.
    """

    if not 1 <= max_hotspots <= 1_000:
        raise ValueError("max_hotspots must be between 1 and 1000")
    incompatibilities = _snapshot_incompatibilities(baseline, candidate)
    if incompatibilities:
        return DifferentialProfileReport(
            baseline_snapshot_id=baseline.id,
            candidate_snapshot_id=candidate.id,
            comparable=False,
            incompatibilities=incompatibilities,
        )

    baseline_rows = _hotspots_by_key(baseline, "baseline")
    candidate_rows = _hotspots_by_key(candidate, "candidate")
    deltas = tuple(
        _delta(baseline_rows.get(key), candidate_rows.get(key), key)
        for key in sorted(set(baseline_rows) | set(candidate_rows))
    )
    ranked = tuple(
        sorted(
            deltas,
            key=lambda item: (-abs(item.inclusive_delta), item.stable_key),
        )[:max_hotspots]
    )
    return DifferentialProfileReport(
        baseline_snapshot_id=baseline.id,
        candidate_snapshot_id=candidate.id,
        comparable=True,
        hotspots=ranked,
    )
