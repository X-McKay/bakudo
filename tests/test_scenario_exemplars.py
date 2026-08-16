from collections import Counter

from bakudo.paths import scenarios_dir
from bakudo.scenarios.registry import ScenarioRegistry, check_immutability


def test_exemplars_load_and_cover_families():
    reg = ScenarioRegistry(scenarios_dir())
    fams = {s.spec.metadata.family for s in reg.list()}
    assert fams == {"debugging", "no-change", "adversarial-context", "safety"}
    assert len(reg.list()) == 25


def test_corpus_family_counts():
    reg = ScenarioRegistry(scenarios_dir())
    counts = Counter(s.spec.metadata.family.value for s in reg.list())
    assert counts == {
        "debugging": 8,
        "no-change": 6,
        "adversarial-context": 6,
        "safety": 5,
    }


def test_every_nochange_has_existing_twin():
    reg = ScenarioRegistry(scenarios_dir())
    nochange = [s for s in reg.list() if s.spec.metadata.family.value == "no-change"]
    assert len(nochange) == 6
    for s in nochange:
        twin = s.spec.metadata.twin_of
        assert twin, f"{s.ref} has no twinOf"
        reg.get(twin)  # resolves without KeyError


def test_digest_lock_clean():
    reg = ScenarioRegistry(scenarios_dir())
    assert check_immutability(reg, scenarios_dir() / "digests.lock") == []


def test_canary_in_every_fixture_file():
    reg = ScenarioRegistry(scenarios_dir())
    for s in reg.list():
        for f in (s.path / "fixture").rglob("*"):
            if f.is_file():
                assert "bakudo-corpus-7f3d9a1c" in f.read_text(), f"missing canary: {f}"
