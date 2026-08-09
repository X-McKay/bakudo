"""Live repository signal collectors feeding the curriculum (spec section 16.1).

These turn real artifacts into :class:`RepoSignals`, which
:func:`generate_objectives` then maps to candidate objectives:

* :class:`TodoCollector`      — TODO/FIXME comments in a checked-out worktree.
* :class:`CoverageXmlCollector` — low-coverage files from a Cobertura ``coverage.xml``.
* :class:`JUnitCollector`     — failing tests from a JUnit ``results.xml``.
* :class:`GitHubIssuesCollector` — open issues via the GitHub REST API.
* :class:`CompositeCollector` — merge several collectors into one snapshot.

The local collectors run with no network and are unit-tested. The GitHub
collector lazily imports ``httpx`` and is constructed from env in
:func:`build_default_collector`.
"""

from __future__ import annotations

import logging
import os
import re
import subprocess
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any, Protocol

from .observe import CoverageGap, FailingTest, Issue, RepoSignals, Todo

_log = logging.getLogger(__name__)

_TODO_RE = re.compile(r"\b(TODO|FIXME)\b[:\s]\s*(.+)")
# Files we will scan for TODOs when no git index is available.
_TEXT_GLOBS = ("*.py", "*.md", "*.rs", "*.ts", "*.tsx", "*.js", "*.go", "*.yaml", "*.toml")


class SignalCollector(Protocol):
    def collect(self, repo: str) -> RepoSignals: ...


def _merge(repo: str, snapshots: list[RepoSignals]) -> RepoSignals:
    merged = RepoSignals(repo=repo)
    for s in snapshots:
        merged.issues += s.issues
        merged.failing_tests += s.failing_tests
        merged.todos += s.todos
        merged.coverage_gaps += s.coverage_gaps
        merged.advisories += s.advisories
    return merged


class CompositeCollector:
    """Run several collectors and merge their signals.

    Collectors are isolated from each other (MEM-14): one failing collector
    (e.g. a GitHub 403) is logged and skipped, and the rest still contribute
    to the snapshot.
    """

    def __init__(self, collectors: list[SignalCollector]) -> None:
        self._collectors = collectors

    def collect(self, repo: str) -> RepoSignals:
        snapshots: list[RepoSignals] = []
        for collector in self._collectors:
            try:
                snapshots.append(collector.collect(repo))
            except Exception:
                _log.exception(
                    "signal collector %s failed for repo %s; skipping it",
                    type(collector).__name__,
                    repo,
                )
        return _merge(repo, snapshots)


class TodoCollector:
    """Scan a checked-out worktree for TODO/FIXME comments."""

    def __init__(self, root: str | Path, *, max_items: int = 200) -> None:
        self._root = Path(root)
        self._max_items = max_items

    def _files(self) -> list[Path]:
        # Prefer git's tracked-file list (respects .gitignore); fall back to glob.
        try:
            out = subprocess.run(
                ["git", "ls-files"], cwd=self._root, capture_output=True, text=True, check=True
            )
            return [self._root / line for line in out.stdout.splitlines() if line.strip()]
        except (subprocess.CalledProcessError, FileNotFoundError):
            files: list[Path] = []
            for pattern in _TEXT_GLOBS:
                files.extend(self._root.rglob(pattern))
            return files

    def collect(self, repo: str) -> RepoSignals:
        todos: list[Todo] = []
        for path in self._files():
            if len(todos) >= self._max_items:
                break
            try:
                text = path.read_text(errors="ignore")
            except (OSError, UnicodeDecodeError):
                continue
            for match in _TODO_RE.finditer(text):
                rel = path.relative_to(self._root).as_posix()
                todos.append(Todo(path=rel, text=match.group(2).strip()[:200]))
                if len(todos) >= self._max_items:
                    break
        return RepoSignals(repo=repo, todos=todos)


class CoverageXmlCollector:
    """Emit coverage gaps from a Cobertura ``coverage.xml`` below a threshold."""

    def __init__(self, path: str | Path, *, threshold: float = 0.8) -> None:
        self._path = Path(path)
        self._threshold = threshold

    def collect(self, repo: str) -> RepoSignals:
        if not self._path.is_file():
            return RepoSignals(repo=repo)
        root = ET.parse(self._path).getroot()
        gaps: list[CoverageGap] = []
        for cls in root.iter("class"):
            filename = cls.get("filename")
            rate = cls.get("line-rate")
            if filename is None or rate is None:
                continue
            covered = float(rate)
            if covered < self._threshold:
                gaps.append(CoverageGap(path=filename, covered_pct=covered))
        return RepoSignals(repo=repo, coverage_gaps=gaps)


class JUnitCollector:
    """Emit failing tests from a JUnit ``results.xml``."""

    def __init__(self, path: str | Path) -> None:
        self._path = Path(path)

    def collect(self, repo: str) -> RepoSignals:
        if not self._path.is_file():
            return RepoSignals(repo=repo)
        root = ET.parse(self._path).getroot()
        failures: list[FailingTest] = []
        for case in root.iter("testcase"):
            bad = case.find("failure") if case.find("failure") is not None else case.find("error")
            if bad is None:
                continue
            classname = case.get("classname", "")
            name = case.get("name", "test")
            full = f"{classname}.{name}" if classname else name
            message = bad.get("message") or (bad.text or "").strip()
            failures.append(FailingTest(name=full, message=message[:500]))
        return RepoSignals(repo=repo, failing_tests=failures)


class GitHubIssuesCollector:
    """Collect open issues via the GitHub REST API. Requires ``httpx``."""

    def __init__(self, repo: str, token: str | None = None, *, limit: int = 50) -> None:
        self._repo = repo
        self._token = token
        self._limit = limit

    @staticmethod
    def issues_from_json(payload: list[dict[str, Any]]) -> list[Issue]:
        """Map a GitHub issues API payload to Issue signals (PRs excluded)."""
        issues: list[Issue] = []
        for item in payload:
            if "pull_request" in item:  # the issues endpoint also returns PRs
                continue
            issues.append(
                Issue(
                    number=int(item.get("number", 0)),
                    title=item.get("title", ""),
                    body=item.get("body") or "",
                    labels=[
                        (lbl.get("name", "") if isinstance(lbl, dict) else str(lbl))
                        for lbl in item.get("labels", [])
                    ],
                )
            )
        return issues

    def collect(self, repo: str) -> RepoSignals:
        import httpx  # lazy

        headers = {"Accept": "application/vnd.github+json"}
        if self._token:
            headers["Authorization"] = f"Bearer {self._token}"
        url = f"https://api.github.com/repos/{self._repo}/issues"
        resp = httpx.get(
            url, headers=headers, params={"state": "open", "per_page": self._limit}, timeout=30
        )
        resp.raise_for_status()
        return RepoSignals(repo=repo, issues=self.issues_from_json(resp.json()))


def build_default_collector(repo: str) -> SignalCollector | None:
    """Assemble a collector from environment configuration.

    Recognised env vars:

    * ``BAKUDO_REPO_PATH``    — worktree to scan for TODO/FIXME.
    * ``BAKUDO_COVERAGE_XML`` — Cobertura coverage report path.
    * ``BAKUDO_JUNIT_XML``    — JUnit results path.
    * ``GITHUB_TOKEN``        — enables the GitHub issues collector for an
                                ``owner/name`` repo.

    Returns ``None`` when nothing is configured (the observer then emits no
    objectives rather than guessing).
    """
    collectors: list[SignalCollector] = []
    if repo_path := os.environ.get("BAKUDO_REPO_PATH"):
        collectors.append(TodoCollector(repo_path))
    if coverage := os.environ.get("BAKUDO_COVERAGE_XML"):
        collectors.append(CoverageXmlCollector(coverage))
    if junit := os.environ.get("BAKUDO_JUNIT_XML"):
        collectors.append(JUnitCollector(junit))
    if (token := os.environ.get("GITHUB_TOKEN")) and "/" in repo:
        collectors.append(GitHubIssuesCollector(repo, token))

    if not collectors:
        return None
    if len(collectors) == 1:
        return collectors[0]
    return CompositeCollector(collectors)
