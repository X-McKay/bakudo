from __future__ import annotations

import pytest

from bakudo.performance.models import (
    Hotspot,
    HotspotKind,
    PerformanceSnapshot,
    ProfilerDescriptor,
    RecordStatus,
)
from bakudo.performance.pins import EnvironmentPin, RevisionPin, WorkloadPin
from bakudo.performance.profile_comparison import (
    HotspotChange,
    ProfileComparisonError,
    compare_profile_snapshots,
)

_DIGEST = "sha256:" + "a" * 64
_WORKLOAD = WorkloadPin(
    source_uri="file:///workloads",
    source_kind="directory",
    collection_revision="rev-1",
    name="python-loop",
    version="1.0.0",
    manifest_digest=_DIGEST,
    bundle_digest=_DIGEST,
)
_ENVIRONMENT = EnvironmentPin(
    bakudo_version="3.0.0",
    abox_version="1.0.0",
    image_digest=_DIGEST,
    profile="python-small",
    hardware_class="test",
    architecture="arm64",
    cpu_count=2,
    memory_mb=512,
    os="linux",
    kernel="6.0",
    dependency_lock_digest=_DIGEST,
    environment_digest=_DIGEST,
    profiler_adapter="python.sampling",
    profiler_version="1",
)


def _snapshot(
    *hotspots: Hotspot, environment: EnvironmentPin = _ENVIRONMENT
) -> PerformanceSnapshot:
    return PerformanceSnapshot(
        workload=_WORKLOAD,
        revision=RevisionPin(
            repository="fixture-repo",
            source_uri="file:///repo",
            commit_sha="a" * 40,
            tree_digest=_DIGEST,
        ),
        environment=environment,
        profiler_spec_digest=_DIGEST,
        descriptor=ProfilerDescriptor(
            name="python-cpu",
            adapter="python.sampling",
            version="1",
            signals=("cpu-time",),
        ),
        capture_seconds=0.1,
        hotspots=hotspots,
        sanitization_status="sanitized",
        status=RecordStatus.completed,
    )


def _hotspot(key: str, cost: float, *, label: str | None = None) -> Hotspot:
    return Hotspot(
        kind=HotspotKind.function,
        stable_key=key,
        label=label or key,
        inclusive_cost=cost,
        exclusive_cost=cost / 2,
        sample_count=10,
    )


def test_profile_diff_aligns_and_ranks_normalized_hotspots() -> None:
    baseline = _snapshot(_hotspot("parse", 10), _hotspot("removed", 5))
    candidate = _snapshot(_hotspot("parse", 14), _hotspot("new", 9))

    report = compare_profile_snapshots(baseline, candidate)

    assert report.comparable is True
    assert report.diagnostic_only is True
    assert [hotspot.stable_key for hotspot in report.hotspots] == ["new", "removed", "parse"]
    assert report.hotspots[0].change is HotspotChange.new
    assert report.hotspots[1].change is HotspotChange.removed
    assert report.hotspots[2].inclusive_relative_delta == pytest.approx(0.4)


def test_profile_diff_rejects_incompatible_capture_environment() -> None:
    baseline = _snapshot(_hotspot("parse", 10))
    candidate = _snapshot(
        _hotspot("parse", 9),
        environment=_ENVIRONMENT.model_copy(update={"hardware_class": "different"}),
    )

    report = compare_profile_snapshots(baseline, candidate)

    assert report.comparable is False
    assert report.hotspots == ()
    assert report.incompatibilities == ("environment pins differ",)


def test_profile_diff_rejects_ambiguous_duplicate_stable_keys() -> None:
    baseline = _snapshot(_hotspot("parse", 10), _hotspot("parse", 2))
    candidate = _snapshot(_hotspot("parse", 9))

    with pytest.raises(ProfileComparisonError, match="duplicate hotspot key"):
        compare_profile_snapshots(baseline, candidate)
