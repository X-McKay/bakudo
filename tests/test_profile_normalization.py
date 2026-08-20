from __future__ import annotations

import pytest

from bakudo.performance.models import HotspotKind
from bakudo.performance.normalize import (
    NormalizationError,
    RawHotspot,
    SymbolMap,
    normalize_hotspots,
    normalize_source_path,
)


def test_normalization_scrubs_paths_and_secrets_and_merges_recursion() -> None:
    rows = (
        RawHotspot(
            kind=HotspotKind.function,
            label="dispatch token=super-secret",
            source_path="/workspace/src/dispatch.py",
            source_line=12,
            inclusive_cost=5.0,
            exclusive_cost=3.0,
            sample_count=4,
            percentage=30,
        ),
        RawHotspot(
            kind=HotspotKind.function,
            label="dispatch token=different-secret",
            source_path="/workspace/src/dispatch.py",
            source_line=12,
            inclusive_cost=2.0,
            exclusive_cost=1.0,
            sample_count=2,
            percentage=10,
        ),
    )

    hotspots = normalize_hotspots(rows, SymbolMap(repository_root="/workspace"))

    assert len(hotspots) == 1
    hotspot = hotspots[0]
    assert hotspot.label == "dispatch token=<redacted>"
    assert "super-secret" not in hotspot.stable_key
    assert hotspot.source_path == "src/dispatch.py"
    assert hotspot.inclusive_cost == 7
    assert hotspot.exclusive_cost == 4
    assert hotspot.sample_count == 6
    assert hotspot.percentage == 40


def test_external_and_unknown_frames_are_retained_without_leaking_paths() -> None:
    rows = (
        RawHotspot(
            kind=HotspotKind.function,
            label="native",
            source_path="/usr/lib/python/native.py",
            source_line=8,
            inclusive_cost=2,
        ),
        RawHotspot(
            kind=HotspotKind.function,
            label="built-in",
            source_path="<built-in>",
            inclusive_cost=1,
        ),
    )

    hotspots = normalize_hotspots(rows, SymbolMap(repository_root="/workspace"))

    assert len(hotspots) == 2
    assert all(item.source_path is None for item in hotspots)
    assert {item.quality for item in hotspots} == {"external", "unknown"}
    assert all("/usr/" not in item.stable_key for item in hotspots)


def test_normalization_has_canonical_order_and_stable_keys() -> None:
    rows = (
        RawHotspot(kind=HotspotKind.function, label="b", inclusive_cost=1),
        RawHotspot(kind=HotspotKind.function, label="a", inclusive_cost=3),
        RawHotspot(kind=HotspotKind.function, label="c", inclusive_cost=3),
    )

    forward = normalize_hotspots(rows)
    reverse = normalize_hotspots(tuple(reversed(rows)))

    assert forward == reverse
    assert [item.inclusive_cost for item in forward] == [3, 3, 1]
    assert [item.stable_key for item in forward[:2]] == sorted(
        item.stable_key for item in forward[:2]
    )


@pytest.mark.parametrize(
    ("path", "expected"),
    [
        ("src/main.py", ("src/main.py", "resolved")),
        ("../secret.py", (None, "unknown")),
        ("/other/secret.py", (None, "external")),
        ("<unknown>", (None, "unknown")),
    ],
)
def test_source_path_policy(path: str, expected: tuple[str | None, str]) -> None:
    assert normalize_source_path(path, SymbolMap(repository_root="/workspace")) == expected


def test_normalization_fails_closed_on_excessive_or_invalid_rows() -> None:
    row = RawHotspot(kind=HotspotKind.function, label="hot", inclusive_cost=1)
    with pytest.raises(NormalizationError, match="2 hotspots; limit is 1"):
        normalize_hotspots((row, row), max_hotspots=1)
    with pytest.raises(NormalizationError, match="non-negative"):
        RawHotspot(kind=HotspotKind.function, label="bad", inclusive_cost=-1)
