"""Guards against dependency-declaration drift in ``pyproject.toml``.

The `all` extra duplicates the per-feature extras, so a pin added to one but
not the other silently re-opens a closed bug — most dangerously the
strands `<1.45` cap, which is load-bearing (>=1.45 breaks in-guest structured
output against vLLM). These tests fail fast when the two drift apart.
"""

from __future__ import annotations

import tomllib
from pathlib import Path

PYPROJECT = Path(__file__).resolve().parents[1] / "pyproject.toml"


def _extras() -> dict[str, list[str]]:
    data = tomllib.loads(PYPROJECT.read_text())
    return data["project"]["optional-dependencies"]


def test_all_extra_covers_every_feature_pin() -> None:
    """Every requirement in a feature extra must appear verbatim in `all`.

    `dev` is a tooling extra, not part of the runtime stack, so it is excluded.
    """
    extras = _extras()
    all_reqs = set(extras["all"])
    feature_extras = {k: v for k, v in extras.items() if k not in {"all", "dev"}}
    missing: dict[str, list[str]] = {}
    for name, reqs in feature_extras.items():
        gap = [r for r in reqs if r not in all_reqs]
        if gap:
            missing[name] = gap
    assert not missing, f"`all` extra is missing pins from feature extras: {missing}"


def test_strands_cap_is_pinned_identically() -> None:
    """The load-bearing strands cap must be identical in `runtime` and `all`."""
    extras = _extras()

    def strands_spec(reqs: list[str]) -> str | None:
        return next((r for r in reqs if r.startswith("strands-agents")), None)

    runtime_spec = strands_spec(extras["runtime"])
    all_spec = strands_spec(extras["all"])
    assert runtime_spec == "strands-agents>=1.43,<1.45"
    assert all_spec == runtime_spec, (
        f"strands pin drift: runtime={runtime_spec!r} all={all_spec!r}"
    )
