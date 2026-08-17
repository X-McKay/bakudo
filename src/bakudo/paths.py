"""Resolution of bundled data directories (schemas, skills, agents, smoke tasks).

When bakudo runs from a source checkout, ``schemas/``, ``skills/`` and
``agents/`` live at the repository root, and smoke tasks live at
``smoke/tasks/``. When installed as a wheel, they are force-included
under ``bakudo/_data/`` (see ``pyproject.toml``). This module hides that
difference: the packaged location is resolved via ``importlib.resources``
first, with the source-tree layout as the dev fallback (API-12).
"""

from __future__ import annotations

from functools import cache
from importlib.resources import files
from pathlib import Path

_PKG_ROOT = Path(__file__).resolve().parent


@cache
def _resolve(name: str, source_subpath: str | None = None) -> Path:
    # Packaged location first (installed wheel): a plain filesystem probe —
    # str(files(...)) is only a real path for on-disk packages, and would
    # break on MultiplexedPath/zip traversables even when the data IS on disk.
    packaged = _PKG_ROOT / "_data" / name
    if packaged.is_dir():
        return packaged
    # Source-tree layout (dev checkout). Usually the same name as the
    # packaged dir (e.g. "agents" -> "agents"), but some bundled data lives
    # deeper in the source tree than its packaged flat name suggests (e.g.
    # "smoke-tasks" -> "smoke/tasks") — source_subpath overrides that.
    repo_root = _PKG_ROOT.parents[1]  # src/bakudo -> src -> repo root
    source = repo_root / (source_subpath or name)
    if source.is_dir():
        return source
    # Last chance: ask importlib.resources, accepting the answer only when it
    # names a real directory on disk (e.g. bakudo merged across sys.path
    # entries, where _PKG_ROOT points at the entry without the data).
    try:
        traversable = files("bakudo") / "_data" / name
        if traversable.is_dir():
            candidate = Path(str(traversable))
            if candidate.is_dir():
                return candidate
    except (TypeError, ValueError, OSError, ModuleNotFoundError):
        pass
    raise FileNotFoundError(
        f"Could not locate bundled data directory '{name}'. Looked in {packaged} and {source}."
    )


def schemas_dir() -> Path:
    """Directory containing the JSON Schemas."""
    return _resolve("schemas")


def skills_dir() -> Path:
    """Directory containing the Open Agent Skills packages."""
    return _resolve("skills")


def agents_dir() -> Path:
    """Directory containing the seed AgentSpec YAMLs (``agents/*.yaml``)."""
    return _resolve("agents")


def smoke_tasks_dir() -> Path:
    """Directory containing Bakudo's two self-test TaskSpecs."""

    return _resolve("smoke-tasks", source_subpath="smoke/tasks")
