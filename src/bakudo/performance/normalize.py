"""Pure, stable normalization of adapter-specific diagnostic hotspots."""

from __future__ import annotations

import hashlib
import json
import math
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import PurePosixPath

from .models import ExtensionValue, Hotspot, HotspotKind

MAX_NORMALIZED_HOTSPOTS = 10_000
_SECRET_ASSIGNMENT = re.compile(
    r"(?i)\b(api[_-]?key|access[_-]?token|token|password|secret)\s*[:=]\s*([^\s,;]+)"
)
_BEARER = re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._~+/=-]+")


class NormalizationError(ValueError):
    """Raised when raw profiler evidence cannot be normalized safely."""


@dataclass(frozen=True)
class SymbolMap:
    """Trusted path information used to scrub and relativize source symbols."""

    repository_root: str | None = None
    aliases: tuple[tuple[str, str], ...] = ()

    def __post_init__(self) -> None:
        if self.repository_root is not None and not self.repository_root.startswith("/"):
            raise ValueError("repository_root must be an absolute POSIX path")
        for source, target in self.aliases:
            if not source or not target:
                raise ValueError("symbol aliases cannot be empty")


@dataclass(frozen=True)
class RawHotspot:
    """Adapter-neutral row before path scrubbing, merging, and stable ordering."""

    kind: HotspotKind
    label: str
    inclusive_cost: float
    exclusive_cost: float | None = None
    sample_count: int = 0
    percentage: float | None = None
    source_path: str | None = None
    source_line: int | None = None
    quality: str = "resolved"
    extensions: Mapping[str, ExtensionValue] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if not isinstance(self.kind, HotspotKind):
            raise NormalizationError("hotspot kind must be a HotspotKind")
        if not isinstance(self.label, str) or not self.label:
            raise NormalizationError("hotspot label must be a non-empty string")
        if self.source_path is not None and not isinstance(self.source_path, str):
            raise NormalizationError("hotspot source_path must be a string")
        if not isinstance(self.quality, str) or not self.quality:
            raise NormalizationError("hotspot quality must be a non-empty string")
        if not isinstance(self.extensions, Mapping) or len(self.extensions) > 64:
            raise NormalizationError("hotspot extensions must be a bounded mapping")
        for key, value in self.extensions.items():
            if not isinstance(key, str) or not key:
                raise NormalizationError("hotspot extension keys must be non-empty strings")
            if not isinstance(value, (str, int, float, bool, type(None))):
                raise NormalizationError("hotspot extension values must be scalar")
            if isinstance(value, float) and not math.isfinite(value):
                raise NormalizationError("hotspot extension numbers must be finite")
        numeric = (self.inclusive_cost, self.exclusive_cost, self.percentage)
        if any(value is not None and not math.isfinite(value) for value in numeric):
            raise NormalizationError("hotspot costs and percentage must be finite")
        if self.inclusive_cost < 0 or (self.exclusive_cost is not None and self.exclusive_cost < 0):
            raise NormalizationError("hotspot costs must be non-negative")
        if self.sample_count < 0:
            raise NormalizationError("hotspot sample_count must be non-negative")
        if self.percentage is not None and not 0 <= self.percentage <= 100:
            raise NormalizationError("hotspot percentage must be between 0 and 100")
        if self.source_line is not None and self.source_line < 1:
            raise NormalizationError("hotspot source_line must be positive")


def redact_label(value: str) -> str:
    """Remove common credential forms and bound a user-visible label."""

    redacted = _SECRET_ASSIGNMENT.sub(lambda match: f"{match.group(1)}=<redacted>", value)
    redacted = _BEARER.sub("Bearer <redacted>", redacted)
    redacted = " ".join(redacted.split())
    if not redacted:
        return "<unknown>"
    if len(redacted) <= 512:
        return redacted
    suffix = hashlib.sha256(redacted.encode("utf-8")).hexdigest()[:12]
    return f"{redacted[:496]}…{suffix}"


def _canonical_absolute(value: str) -> PurePosixPath:
    return PurePosixPath("/" + str(PurePosixPath(value)).lstrip("/"))


def normalize_source_path(value: str | None, symbols: SymbolMap) -> tuple[str | None, str]:
    """Return a repository-relative safe path and a symbol quality label."""

    if value is None or not value or value.startswith(("<", "~")):
        return None, "unknown"

    normalized = value.replace("\\", "/")
    for source, target in symbols.aliases:
        if normalized == source or normalized.startswith(source.rstrip("/") + "/"):
            normalized = target.rstrip("/") + normalized[len(source.rstrip("/")) :]
            break

    path = PurePosixPath(normalized)
    if path.is_absolute():
        if symbols.repository_root is None:
            return None, "external"
        root = _canonical_absolute(symbols.repository_root)
        absolute = _canonical_absolute(path.as_posix())
        try:
            path = absolute.relative_to(root)
        except ValueError:
            return None, "external"

    if not path.parts or ".." in path.parts or "." in path.parts:
        return None, "unknown"
    safe = path.as_posix()
    if safe in {"", "."} or len(safe) > 4_096:
        return None, "unknown"
    return safe, "resolved"


def stable_hotspot_key(
    *,
    kind: HotspotKind,
    label: str,
    source_path: str | None,
    source_line: int | None,
) -> str:
    """Create an opaque stable key without embedding potentially sensitive text."""

    identity = {
        "kind": kind.value,
        "label": label,
        "sourceLine": source_line,
        "sourcePath": source_path,
    }
    payload = json.dumps(identity, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return f"{kind.value}:sha256:{hashlib.sha256(payload).hexdigest()}"


@dataclass
class _Aggregate:
    raw: RawHotspot
    label: str
    source_path: str | None
    quality: str
    inclusive_cost: float
    exclusive_cost: float | None
    sample_count: int
    percentage: float | None


_QUALITY_RANK = {"resolved": 0, "partial": 1, "external": 2, "unknown": 3}


def _worse_quality(left: str, right: str) -> str:
    if _QUALITY_RANK.get(left, 2) >= _QUALITY_RANK.get(right, 2):
        return left
    return right


def normalize_hotspots(
    rows: Sequence[RawHotspot],
    symbols: SymbolMap | None = None,
    *,
    max_hotspots: int = MAX_NORMALIZED_HOTSPOTS,
) -> tuple[Hotspot, ...]:
    """Scrub, merge recursive/duplicate rows, and sort them canonically."""

    if symbols is None:
        symbols = SymbolMap()
    if max_hotspots < 1 or max_hotspots > MAX_NORMALIZED_HOTSPOTS:
        raise ValueError(f"max_hotspots must be between 1 and {MAX_NORMALIZED_HOTSPOTS}")
    if len(rows) > max_hotspots:
        raise NormalizationError(f"profile contains {len(rows)} hotspots; limit is {max_hotspots}")

    aggregates: dict[str, _Aggregate] = {}
    for row in rows:
        label = redact_label(row.label)
        source_path, path_quality = normalize_source_path(row.source_path, symbols)
        quality = _worse_quality(row.quality, path_quality) if row.source_path else row.quality
        stable_key = stable_hotspot_key(
            kind=row.kind,
            label=label,
            source_path=source_path,
            source_line=row.source_line,
        )
        current = aggregates.get(stable_key)
        if current is None:
            aggregates[stable_key] = _Aggregate(
                raw=row,
                label=label,
                source_path=source_path,
                quality=quality,
                inclusive_cost=row.inclusive_cost,
                exclusive_cost=row.exclusive_cost,
                sample_count=row.sample_count,
                percentage=row.percentage,
            )
            continue
        current.inclusive_cost += row.inclusive_cost
        if current.exclusive_cost is None or row.exclusive_cost is None:
            current.exclusive_cost = None
        else:
            current.exclusive_cost += row.exclusive_cost
        current.sample_count += row.sample_count
        if current.percentage is None or row.percentage is None:
            current.percentage = None
        else:
            current.percentage = min(100.0, current.percentage + row.percentage)
        current.quality = _worse_quality(current.quality, quality)

    hotspots = [
        Hotspot(
            kind=item.raw.kind,
            stable_key=stable_key,
            label=item.label,
            source_path=item.source_path,
            source_line=item.raw.source_line,
            inclusive_cost=item.inclusive_cost,
            exclusive_cost=item.exclusive_cost,
            sample_count=item.sample_count,
            percentage=item.percentage,
            quality=item.quality,
            extensions=dict(item.raw.extensions),
        )
        for stable_key, item in aggregates.items()
    ]
    return tuple(
        sorted(
            hotspots,
            key=lambda item: (-item.inclusive_cost, -item.sample_count, item.stable_key),
        )
    )
