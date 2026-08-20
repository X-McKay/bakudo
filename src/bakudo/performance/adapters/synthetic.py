"""Deterministic profiler adapter used by contract and orchestration tests."""

from __future__ import annotations

import json
from collections.abc import Sequence
from pathlib import Path

from ..models import EnvironmentPin, Hotspot, HotspotKind, ProfilerDescriptor, ProfilerSpec
from ..normalize import NormalizationError, RawHotspot, SymbolMap, normalize_hotspots
from ..profiler import (
    CapabilityReport,
    CapabilityState,
    CapturedProfile,
    DiagnosticDuration,
    PreparedCapture,
    ProfileArtifactError,
    WorkloadInvocation,
)

_MEDIA_TYPE = "application/vnd.bakudo.synthetic-profile+json"


class SyntheticProfilerAdapter:
    """Return caller-supplied hotspots while still exercising capture contracts."""

    def __init__(self, hotspots: Sequence[RawHotspot] = ()) -> None:
        self._hotspots = tuple(hotspots)

    @property
    def descriptor(self) -> ProfilerDescriptor:
        return ProfilerDescriptor(
            name="synthetic",
            adapter="bakudo.synthetic",
            version="1",
            signals=("synthetic-hotspots",),
        )

    def check_capabilities(self, environment: EnvironmentPin) -> CapabilityReport:
        del environment
        return CapabilityReport(self.descriptor, CapabilityState.available)

    def prepare(self, spec: ProfilerSpec, artifact_dir: Path) -> PreparedCapture:
        if spec.adapter != self.descriptor.adapter:
            raise ValueError(
                f"profiler spec selects {spec.adapter!r}, expected {self.descriptor.adapter!r}"
            )
        return PreparedCapture(artifact_dir / "synthetic-profile.json", "synthetic")

    def build_argv(
        self, prepared: PreparedCapture, invocation: WorkloadInvocation
    ) -> tuple[str, ...]:
        del prepared
        return invocation.argv

    def collect(
        self,
        prepared: PreparedCapture,
        *,
        diagnostic_duration: DiagnosticDuration,
        max_bytes: int,
    ) -> CapturedProfile:
        del prepared
        document = {
            "schemaVersion": 1,
            "hotspots": [
                {
                    "kind": row.kind.value,
                    "label": row.label,
                    "sourcePath": row.source_path,
                    "sourceLine": row.source_line,
                    "inclusiveCost": row.inclusive_cost,
                    "exclusiveCost": row.exclusive_cost,
                    "sampleCount": row.sample_count,
                    "percentage": row.percentage,
                    "quality": row.quality,
                    "extensions": dict(row.extensions),
                }
                for row in self._hotspots
            ],
        }
        content = json.dumps(document, sort_keys=True, separators=(",", ":")).encode()
        if len(content) > max_bytes:
            raise ProfileArtifactError(
                f"profile is {len(content)} bytes; limit is {max_bytes} bytes"
            )
        return CapturedProfile(content, _MEDIA_TYPE, diagnostic_duration)

    def normalize(self, artifact: CapturedProfile, symbols: SymbolMap) -> tuple[Hotspot, ...]:
        if artifact.media_type != _MEDIA_TYPE:
            raise NormalizationError(f"unsupported synthetic media type: {artifact.media_type}")
        try:
            document = json.loads(artifact.content)
            if document.get("schemaVersion") != 1 or not isinstance(document.get("hotspots"), list):
                raise ValueError("invalid synthetic profile shape")
            rows = tuple(
                RawHotspot(
                    kind=HotspotKind(item["kind"]),
                    label=item["label"],
                    source_path=item.get("sourcePath"),
                    source_line=item.get("sourceLine"),
                    inclusive_cost=item["inclusiveCost"],
                    exclusive_cost=item.get("exclusiveCost"),
                    sample_count=item.get("sampleCount", 0),
                    percentage=item.get("percentage"),
                    quality=item.get("quality", "resolved"),
                    extensions=item.get("extensions", {}),
                )
                for item in document["hotspots"]
            )
        except (KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
            raise NormalizationError("malformed synthetic profile") from exc
        return normalize_hotspots(rows, symbols)
