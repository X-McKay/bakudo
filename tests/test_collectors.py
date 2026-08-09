"""Live curriculum signal collectors and the wired collect_signals activity."""

from bakudo.curriculum import RepoSignals, Todo, build_default_collector
from bakudo.curriculum.collectors import (
    CoverageXmlCollector,
    GitHubIssuesCollector,
    JUnitCollector,
    TodoCollector,
)
from bakudo.temporal import _impl
from bakudo.temporal.shared import ObserveInput


def test_todo_collector_scans_worktree(tmp_path):
    (tmp_path / "mod.py").write_text("x = 1  # TODO: handle the timeout case\n")
    (tmp_path / "readme.md").write_text("Nothing actionable here.\n")
    signals = TodoCollector(tmp_path).collect("r")
    assert len(signals.todos) == 1
    assert signals.todos[0].path == "mod.py"
    assert "timeout" in signals.todos[0].text


def test_coverage_collector_flags_low_files(tmp_path):
    xml = tmp_path / "coverage.xml"
    xml.write_text(
        """<coverage>
          <packages><package><classes>
            <class filename="src/low.py" line-rate="0.20"/>
            <class filename="src/high.py" line-rate="0.95"/>
          </classes></package></packages>
        </coverage>"""
    )
    gaps = CoverageXmlCollector(xml, threshold=0.8).collect("r").coverage_gaps
    assert [g.path for g in gaps] == ["src/low.py"]
    assert gaps[0].covered_pct == 0.20


def test_junit_collector_extracts_failures(tmp_path):
    xml = tmp_path / "results.xml"
    xml.write_text(
        """<testsuite>
          <testcase classname="tests.test_a" name="test_ok"/>
          <testcase classname="tests.test_a" name="test_bad">
            <failure message="boom">trace</failure>
          </testcase>
        </testsuite>"""
    )
    fails = JUnitCollector(xml).collect("r").failing_tests
    assert len(fails) == 1
    assert fails[0].name == "tests.test_a.test_bad"
    assert fails[0].message == "boom"


def test_github_issue_mapping_excludes_prs():
    payload = [
        {"number": 1, "title": "A bug", "body": "x", "labels": [{"name": "bug"}]},
        {"number": 2, "title": "A PR", "pull_request": {"url": "..."}, "labels": []},
    ]
    issues = GitHubIssuesCollector.issues_from_json(payload)
    assert [i.number for i in issues] == [1]
    assert issues[0].labels == ["bug"]


def test_build_default_collector_is_none_without_config(monkeypatch):
    for var in ("BAKUDO_REPO_PATH", "BAKUDO_COVERAGE_XML", "BAKUDO_JUNIT_XML", "GITHUB_TOKEN"):
        monkeypatch.delenv(var, raising=False)
    assert build_default_collector("owner/repo") is None


def test_collect_signals_uses_injected_collector(monkeypatch):
    class FakeCollector:
        def collect(self, repo):
            return RepoSignals(repo=repo, todos=[Todo(path="a.py", text="do it")])

    monkeypatch.setattr(_impl.DEPS, "collector", FakeCollector())
    objectives = _impl.collect_signals(ObserveInput(repo="r"))
    assert objectives and objectives[0]["type"] == "maintenance"
    assert objectives[0]["repo"] == "r"


def test_collect_signals_empty_without_collector(monkeypatch):
    monkeypatch.setattr(_impl.DEPS, "collector", None)
    for var in ("BAKUDO_REPO_PATH", "BAKUDO_COVERAGE_XML", "BAKUDO_JUNIT_XML", "GITHUB_TOKEN"):
        monkeypatch.delenv(var, raising=False)
    assert _impl.collect_signals(ObserveInput(repo="r")) == []


def test_two_observe_cycles_over_unchanged_repo_yield_identical_objective_ids(
    tmp_path, monkeypatch
):
    """MEM-6 end-to-end: an unchanged worktree scanned in two observer cycles
    produces byte-identical objective ids, enabling dedupe-by-id downstream."""
    (tmp_path / "app.py").write_text("# TODO: handle timeout\n")
    monkeypatch.setattr(_impl.DEPS, "collector", TodoCollector(tmp_path))

    first = _impl.collect_signals(ObserveInput(repo="payments-api"))
    second = _impl.collect_signals(ObserveInput(repo="payments-api"))

    assert [o["id"] for o in first] == [o["id"] for o in second]
    assert first and first[0]["id"].startswith("objd_")
