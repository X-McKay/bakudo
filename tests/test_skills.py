import pytest

from bakudo.skills import SkillRegistry, parse_skill_frontmatter


def test_discovery_manifest_lists_seed_skills():
    names = {s["name"] for s in SkillRegistry().discovery_manifest()}
    assert {
        "codebase-navigation",
        "test-selection",
        "safe-refactor",
        "workload-authoring",
        "repo-onboarding",
    } <= names


def test_operator_onramp_skills_load_their_procedures():
    reg = SkillRegistry()
    assert "wall clock" in reg.load_skill("workload-authoring")["body"]
    assert "prepare.sh" in reg.load_skill("repo-onboarding")["body"]


def test_progressive_disclosure_body_loaded_on_demand():
    reg = SkillRegistry()
    manifest = reg.discovery_manifest()
    # Manifest entries do not carry the full body.
    assert all("body" not in entry for entry in manifest)
    loaded = reg.load_skill("test-selection")
    assert "Test Selection" in loaded["body"]
    assert "select_tests.py" in loaded["scripts"]


def test_allowlist_restricts_available_skills():
    reg = SkillRegistry(allowed=["test-selection"])
    names = {s["name"] for s in reg.discovery_manifest()}
    assert names == {"test-selection"}
    with pytest.raises(PermissionError):
        reg.load_skill("safe-refactor")


def test_empty_allowlist_exposes_no_skills():
    reg = SkillRegistry(allowed=[])
    assert reg.discovery_manifest() == []
    with pytest.raises(PermissionError):
        reg.load_skill("test-selection")


def test_frontmatter_parsing():
    front, body = parse_skill_frontmatter("---\nname: x\n---\nhello")
    assert front["name"] == "x"
    assert body.strip() == "hello"
