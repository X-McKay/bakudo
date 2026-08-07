import pytest

from bakudo.skills import SkillRegistry, parse_skill_frontmatter


def test_discovery_manifest_lists_seed_skills():
    names = {s["name"] for s in SkillRegistry().discovery_manifest()}
    assert {"codebase-navigation", "test-selection", "safe-refactor"} <= names


def test_progressive_disclosure_body_loaded_on_demand():
    reg = SkillRegistry()
    manifest = reg.discovery_manifest()
    # Manifest entries do not carry the full body.
    assert all("body" not in entry for entry in manifest)
    loaded = reg.load_skill("test-selection")
    assert "Test Selection" in loaded["body"]
    assert "select_tests.py" in loaded["scripts"]


def test_allowlist_restricts_available_skills():
    reg = SkillRegistry(allowed=["test-selection@^1.0"])
    names = {s["name"] for s in reg.discovery_manifest()}
    assert names == {"test-selection"}
    with pytest.raises(PermissionError):
        reg.load_skill("safe-refactor")


def test_frontmatter_parsing():
    front, body = parse_skill_frontmatter("---\nname: x\n---\nhello")
    assert front["name"] == "x"
    assert body.strip() == "hello"
