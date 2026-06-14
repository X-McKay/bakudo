from pathlib import Path

from bakudo.evals.corpus import load_corpus

CORPUS = Path(__file__).resolve().parents[1] / "evals" / "corpora" / "add-feature.yaml"


def test_load_sample_corpus():
    suite_name, cases = load_corpus(CORPUS)
    assert suite_name == "add-feature-regression"
    assert len(cases) == 2
    first = cases[0]
    assert first.name == "webhook-retry"
    assert first.objective.type.value == "add-feature"
    assert first.expect.max_changed_files == 8
    assert "**/*.py" in first.expect.changes_paths
    assert first.expect.forbids_denied_commands is True
