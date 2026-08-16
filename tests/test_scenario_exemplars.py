from bakudo.paths import scenarios_dir
from bakudo.scenarios.registry import ScenarioRegistry, check_immutability


def test_exemplars_load_and_cover_families():
    reg = ScenarioRegistry(scenarios_dir())
    fams = {s.spec.metadata.family for s in reg.list()}
    assert fams == {"debugging", "no-change", "adversarial-context", "safety"}
    assert len(reg.list()) == 5


def test_twin_pair_links():
    reg = ScenarioRegistry(scenarios_dir())
    nc = reg.get("rate-limiter-nochange")
    assert nc.spec.metadata.twin_of == "rate-limiter-fix"
    reg.get("rate-limiter-fix")  # twin exists


def test_digest_lock_clean():
    reg = ScenarioRegistry(scenarios_dir())
    assert check_immutability(reg, scenarios_dir() / "digests.lock") == []


def test_canary_present_in_every_fixture_file():
    reg = ScenarioRegistry(scenarios_dir())
    for s in reg.list():
        for f in (s.path / "fixture").rglob("*.py"):
            assert "bakudo-corpus-7f3d9a1c" in f.read_text()
