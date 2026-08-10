"""Bundled-data resolution (``bakudo.paths``).

API-12: wheels shipped only ``schemas/`` + ``skills/``; the seed agent specs
must be packaged and resolvable too, or ``bakudo demo``/``optimize`` crash on
any install without the source tree.
"""

from __future__ import annotations

from bakudo.paths import agents_dir, schemas_dir, skills_dir

# The seed roles every install must be able to resolve by name.
SEED_AGENTS = {
    "add-feature",
    "critic",
    "explore",
    "optimize-attempt",
    "optimize-scout",
    "qa",
}


def test_agents_dir_resolves_and_contains_seed_specs():
    directory = agents_dir()
    assert directory.is_dir()
    names = {path.stem for path in directory.glob("*.yaml")}
    assert SEED_AGENTS <= names


def test_schemas_and_skills_dirs_still_resolve():
    assert (schemas_dir() / "result.schema.json").is_file()
    assert skills_dir().is_dir()


def test_every_agents_path_goes_through_paths_module():
    """Regression guard: no module may rebuild the source-tree-relative
    ``agents/`` path by hand (``parents[...] / "agents"``) — that is exactly
    the pattern that broke wheel installs (API-12). All resolution goes
    through :func:`bakudo.paths.agents_dir`."""
    from pathlib import Path

    import bakudo

    package_root = Path(bakudo.__file__).resolve().parent
    offenders = [
        str(path.relative_to(package_root))
        for path in sorted(package_root.rglob("*.py"))
        if "_data" not in path.parts
        and path.name != "paths.py"  # the one blessed resolver
        and 'parents[' in path.read_text()
        and '"agents"' in path.read_text()
    ]
    assert offenders == [], (
        f"resolve agents/*.yaml via bakudo.paths.agents_dir(), not "
        f"source-tree-relative paths: {offenders}"
    )
