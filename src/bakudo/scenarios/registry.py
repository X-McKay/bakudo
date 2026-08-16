"""Scenario discovery, content-addressed digests, and immutability checks.

A scenario is a directory under an ``evals/scenarios``-style root that
contains a ``scenario.yaml`` (validated against the JSON Schema, then parsed
into a :class:`~bakudo.scenarios.models.ScenarioSpec`), plus whatever fixture
and hidden-test files the scenario needs. Discovery only recognises
subdirectories that contain a ``scenario.yaml`` — any other file sitting in
the root (e.g. a committed ``digests.lock``) is ignored, and is never part of
a scenario's digest (digests are computed per scenario directory, not over
the registry root).

The digest is the trust primitive for scenario immutability (experiment
substrate design doc section 5): once a scenario ref (``name@version``) has
been used in an experiment, its content must not change without a version
bump. ``check_immutability`` compares the live registry's digests against a
committed lockfile and flags any ref whose digest silently drifted.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path

import yaml

from ..schema import validate_scenario_spec
from .models import ScenarioSpec


class ScenarioLoadError(ValueError):
    """Raised when a scenario directory's ``scenario.yaml`` fails to parse
    or validate. Always carries the offending file path."""


def load_scenario(scenario_dir: Path) -> ScenarioSpec:
    """Parse and validate ``<scenario_dir>/scenario.yaml``.

    Validates against the JSON Schema first, then against the pydantic
    model. Errors carry the file path so a failure in a large registry is
    easy to locate.
    """
    scenario_file = scenario_dir / "scenario.yaml"
    try:
        data = yaml.safe_load(scenario_file.read_text())
    except OSError as exc:
        raise ScenarioLoadError(f"{scenario_file}: {exc}") from exc
    except yaml.YAMLError as exc:
        raise ScenarioLoadError(f"{scenario_file}: invalid YAML: {exc}") from exc

    try:
        validate_scenario_spec(data)
        return ScenarioSpec.model_validate(data)
    except Exception as exc:
        raise ScenarioLoadError(f"{scenario_file}: {exc}") from exc


def scenario_digest(scenario_dir: Path) -> str:
    """A sha256 hex digest over sorted relative paths + file bytes of the
    whole directory. Stable across re-hashing the same content; sensitive
    to any file addition, removal, or byte-level change."""
    h = hashlib.sha256()
    for path in sorted(p for p in scenario_dir.rglob("*") if p.is_file()):
        rel = path.relative_to(scenario_dir).as_posix()
        h.update(rel.encode()); h.update(b"\0"); h.update(path.read_bytes()); h.update(b"\1")  # noqa: E702
    return h.hexdigest()


@dataclass(frozen=True)
class LoadedScenario:
    """A scenario discovered by the registry: its parsed spec, its
    on-disk directory, and its content digest."""

    spec: ScenarioSpec
    path: Path
    digest: str

    @property
    def ref(self) -> str:
        return self.spec.ref


class ScenarioRegistry:
    """Discovers scenarios under ``root``.

    Only immediate subdirectories of ``root`` that contain a
    ``scenario.yaml`` are treated as scenarios; other files or directories
    at the root (e.g. a ``digests.lock``) are ignored.
    """

    def __init__(self, root: Path) -> None:
        self._root = root
        self._scenarios: dict[str, LoadedScenario] = {}
        self._discover()

    def _discover(self) -> None:
        if not self._root.is_dir():
            return
        for child in sorted(self._root.iterdir()):
            if not child.is_dir():
                continue
            if not (child / "scenario.yaml").is_file():
                continue
            spec = load_scenario(child)
            digest = scenario_digest(child)
            loaded = LoadedScenario(spec=spec, path=child, digest=digest)
            self._scenarios[loaded.ref] = loaded

    def list(
        self,
        family: str | None = None,
        partitions: Sequence[str] | None = None,
        tags: Sequence[str] | None = None,
    ) -> list[LoadedScenario]:
        """All discovered scenarios, optionally filtered."""
        results = list(self._scenarios.values())
        if family is not None:
            results = [s for s in results if s.spec.metadata.family.value == family]
        if partitions is not None:
            allowed_partitions = set(partitions)
            results = [s for s in results if s.spec.metadata.partition.value in allowed_partitions]
        if tags is not None:
            required_tags = set(tags)
            results = [s for s in results if required_tags & set(s.spec.metadata.tags)]
        return results

    def get(self, name: str) -> LoadedScenario:
        """Look up a scenario by ref (``name@version``).

        Raises ``KeyError`` listing the known refs when ``name`` is absent.
        """
        try:
            return self._scenarios[name]
        except KeyError:
            known = ", ".join(sorted(self._scenarios)) or "<none>"
            raise KeyError(f"Unknown scenario ref: {name!r}. Known refs: {known}") from None


def check_immutability(registry: ScenarioRegistry, lockfile: Path) -> list[str]:
    """Compare the registry's live digests against a committed lockfile.

    Returns a violation message for each ref present in the lockfile whose
    digest no longer matches the live scenario content (i.e. the scenario
    changed without a version bump, since a version bump produces a new
    ref). Refs only present in one side (new scenarios, or refs removed
    from the registry) are not violations.
    """
    if not lockfile.is_file():
        return []
    locked: dict[str, str] = json.loads(lockfile.read_text())
    live = {s.ref: s.digest for s in registry.list()}
    violations = []
    for ref, locked_digest in locked.items():
        live_digest = live.get(ref)
        if live_digest is None:
            continue
        if live_digest != locked_digest:
            violations.append(
                f"{ref}: digest changed ({locked_digest} -> {live_digest}) "
                "without a version bump"
            )
    return violations


def update_lock(registry: ScenarioRegistry, lockfile: Path) -> None:
    """Rewrite ``lockfile`` with the registry's current ``{ref: digest}``."""
    data = {s.ref: s.digest for s in registry.list()}
    lockfile.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n")
