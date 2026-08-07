"""Resolution of bundled data directories (schemas and skills).

When bakudo runs from a source checkout, ``schemas/`` and ``skills/`` live at
the repository root. When installed as a wheel, they are force-included under
``bakudo/_data/`` (see ``pyproject.toml``). This module hides that difference.
"""

from __future__ import annotations

from functools import cache
from pathlib import Path

_PKG_ROOT = Path(__file__).resolve().parent


@cache
def _resolve(name: str) -> Path:
    # Packaged location first (installed wheel), then source-tree fallback.
    packaged = _PKG_ROOT / "_data" / name
    if packaged.is_dir():
        return packaged
    repo_root = _PKG_ROOT.parents[1]  # src/bakudo -> src -> repo root
    source = repo_root / name
    if source.is_dir():
        return source
    raise FileNotFoundError(
        f"Could not locate bundled data directory '{name}'. "
        f"Looked in {packaged} and {source}."
    )


def schemas_dir() -> Path:
    """Directory containing the JSON Schemas."""
    return _resolve("schemas")


def skills_dir() -> Path:
    """Directory containing the Open Agent Skills packages."""
    return _resolve("skills")
