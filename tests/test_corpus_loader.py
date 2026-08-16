"""``load_corpus`` unit coverage against an inline, out-of-tree YAML fixture.

The bundled example corpora this file used to read
(``evals/corpora/add-feature.yaml``) were retired in Task 7 in favor of the
scenario registry (see ``tests/test_corpus_adapter.py``); ``load_corpus``
itself is still a supported way to load a real, out-of-tree legacy corpus, so
this file covers that path with a fixture it owns instead.
"""

from pathlib import Path

import pytest

from bakudo.evals.corpus import load_corpus

CORPUS_YAML = """\
name: add-feature-regression

cases:
  - name: webhook-retry
    objective:
      type: add-feature
      repo: payments-api
      title: Add retry handling to webhook delivery
      acceptanceCriteria:
        - Retries transient 5xx responses with exponential backoff
        - Does not retry 4xx responses
      constraints:
        maxFilesChanged: 8
    expect:
      status: success
      changesPaths:
        - "**/*.py"
      forbidsDeniedCommands: true
      maxChangedFiles: 8

  - name: idempotent-consumer
    objective:
      type: add-feature
      repo: payments-api
      title: Make the event consumer idempotent
      acceptanceCriteria:
        - Duplicate events are processed at most once
    expect:
      status: success
      changesPaths:
        - "**/*.py"
      forbidsDeniedCommands: true
"""


@pytest.fixture
def corpus_path(tmp_path: Path) -> Path:
    path = tmp_path / "add-feature.yaml"
    path.write_text(CORPUS_YAML)
    return path


def test_load_sample_corpus(corpus_path: Path):
    suite_name, cases = load_corpus(corpus_path)
    assert suite_name == "add-feature-regression"
    assert len(cases) == 2
    first = cases[0]
    assert first.name == "webhook-retry"
    assert first.objective.type.value == "add-feature"
    assert first.expect.max_changed_files == 8
    assert "**/*.py" in first.expect.changes_paths
    assert first.expect.forbids_denied_commands is True
