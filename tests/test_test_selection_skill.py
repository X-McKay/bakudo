from __future__ import annotations

import importlib.util
from pathlib import Path

SCRIPT = (
    Path(__file__).resolve().parents[1]
    / "skills"
    / "test-selection"
    / "scripts"
    / "select_tests.py"
)
SPEC = importlib.util.spec_from_file_location("test_selection_skill", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def test_package_level_test_is_a_candidate():
    candidates = MODULE.candidate_tests("src/bakudo/skills/registry.py")
    assert "tests/test_registry.py" in candidates
    assert "tests/test_skills.py" in candidates
    assert "tests/skills/test_registry.py" in candidates


def test_existing_tests_filters_nonexistent_candidates(tmp_path):
    tests = tmp_path / "tests"
    tests.mkdir()
    (tests / "test_skills.py").write_text("")

    selected = MODULE.existing_tests(
        ["tests/test_registry.py", "tests/test_skills.py"], root=tmp_path
    )

    assert selected == ["tests/test_skills.py"]
