"""Bundled-data resolution (``bakudo.paths``).

API-12: wheels shipped only ``schemas/`` + ``skills/``; the seed agent specs
must be packaged and resolvable too, or ``bakudo demo``/``optimize`` crash on
any install without the source tree.
"""

from __future__ import annotations

import re

from bakudo.paths import agents_dir, scenarios_dir, schemas_dir, skills_dir

# The seed roles every install must be able to resolve by name.
SEED_AGENTS = {
    "add-feature",
    "critic",
    "explore",
    "optimize-attempt",
    "optimize-scout",
    "qa",
}

# The exemplar scenarios (Task 4) every install must be able to resolve.
EXEMPLAR_SCENARIOS = {
    "csv-sum-offbyone",
    "rate-limiter-nochange",
    "rate-limiter-fix",
    "retry-misdiagnosis",
    "config-scope-trap",
    "lru-cache-fix",
    "date-range-fix",
    "dedupe-orders-fix",
    "retry-backoff-fix",
    "slugify-fix",
    "inventory-stale-read",
}


def test_resolve_prefers_plain_filesystem_probe_over_importlib(monkeypatch, tmp_path):
    """PR#48 review: ``files("bakudo")`` can return a non-filesystem
    traversable (MultiplexedPath for merged namespace paths, zip Traversable
    for zipapps) whose str() is a repr, not a path. The packaged layout must
    resolve via the plain ``<pkg>/_data/<name>`` filesystem probe first, so a
    weird traversable cannot break an install whose data is on disk."""
    from bakudo import paths

    class NotAPath:
        """Traversable stand-in whose str() is not a usable path."""

        def __truediv__(self, _other):
            return self

        def is_dir(self):
            return False

        def __str__(self):
            return "<MultiplexedPath('...')>"

    pkg_root = tmp_path / "site-packages" / "bakudo"
    (pkg_root / "_data" / "agents").mkdir(parents=True)
    monkeypatch.setattr(paths, "_PKG_ROOT", pkg_root)
    monkeypatch.setattr(paths, "files", lambda _pkg: NotAPath())
    paths._resolve.cache_clear()
    try:
        assert paths.agents_dir() == pkg_root / "_data" / "agents"
    finally:
        paths._resolve.cache_clear()


def test_agents_dir_resolves_and_contains_seed_specs():
    directory = agents_dir()
    assert directory.is_dir()
    names = {path.stem for path in directory.glob("*.yaml")}
    assert SEED_AGENTS <= names


def test_schemas_and_skills_dirs_still_resolve():
    assert (schemas_dir() / "result.schema.json").is_file()
    assert skills_dir().is_dir()


def test_scenarios_dir_resolves_and_contains_exemplars():
    directory = scenarios_dir()
    assert directory.is_dir()
    names = {
        path.name for path in directory.iterdir() if (path / "scenario.yaml").is_file()
    }
    assert names == EXEMPLAR_SCENARIOS


# A hand-built agents path in any spelling: the quoted segment ('agents' or
# "agents") in a path-construction context — pathlib's `/` operator,
# a parents[N]/__file__-relative base, os.path.join — or an 'agents/...'
# path embedded in a (possibly f-) string literal.
_HAND_BUILT_AGENTS_PATH = re.compile(
    r"""(?x)
      (?: parents\[\d+\]      # Path(__file__).resolve().parents[N] ...
        | __file__            # any __file__-relative base
        | os\.path\.join      # os.path.join(..., 'agents', ...)
        | /\s*                # the pathlib `/` operator
      ) [^\n]* ['\"]agents['\"]
    | ['\"]agents/            # "agents/explore.yaml" as a literal path
    """
)


def test_hand_built_agents_path_pattern_catches_known_bypasses():
    """The guard below is only as good as its pattern — pin the spellings the
    PR#48 review showed slipping past a double-quote-only grep."""
    bypasses = [
        'Path(__file__).resolve().parents[3] / "agents" / "explore.yaml"',
        "Path(__file__).resolve().parents[3] / 'agents' / f'{name}.yaml'",
        "repo_root / 'agents' / 'explore.yaml'",
        "os.path.join(root, 'agents', name + '.yaml')",
        'spec = load(f"agents/{name}.yaml")',
        "spec = load('agents/explore.yaml')",
    ]
    for snippet in bypasses:
        assert _HAND_BUILT_AGENTS_PATH.search(snippet), f"pattern misses: {snippet}"
    innocent = [
        "spec = load_spec_file(agents_dir() / f'{name}.yaml')",
        "# the repo's seed agents live in agents_dir()",
        "tools.register_agent_spec(spec)",
    ]
    for snippet in innocent:
        assert not _HAND_BUILT_AGENTS_PATH.search(snippet), f"false positive: {snippet}"


def test_every_agents_path_goes_through_paths_module():
    """Regression guard: no module may rebuild the ``agents/`` path by hand —
    that is exactly the pattern that broke wheel installs (API-12). All
    resolution goes through :func:`bakudo.paths.agents_dir`."""
    from pathlib import Path

    import bakudo

    package_root = Path(bakudo.__file__).resolve().parent
    offenders = [
        f"{path.relative_to(package_root)}:{lineno}: {line.strip()}"
        for path in sorted(package_root.rglob("*.py"))
        if "_data" not in path.parts
        and path.name != "paths.py"  # the one blessed resolver
        for lineno, line in enumerate(path.read_text().splitlines(), start=1)
        if _HAND_BUILT_AGENTS_PATH.search(line)
    ]
    assert offenders == [], (
        f"resolve agents/*.yaml via bakudo.paths.agents_dir(), not "
        f"hand-built paths: {offenders}"
    )
