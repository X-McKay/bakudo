from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from bakudo.performance.prescreen import PrescreenError, run_prescreen
from bakudo.performance.source import DirectoryWorkloadSource, LoadedWorkload


def _loaded() -> LoadedWorkload:
    source = DirectoryWorkloadSource(Path(__file__).parents[1] / "smoke" / "workloads")
    return source.load(source.list()[0].ref)


def _git(repo: Path, *args: str) -> str:
    completed = subprocess.run(
        ["git", "-C", str(repo), *args], check=True, capture_output=True, text=True
    )
    return completed.stdout.strip()


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    repo = tmp_path / "target"
    repo.mkdir()
    subprocess.run(["git", "init", "-q", str(repo)], check=True)
    _git(repo, "config", "user.email", "test@example.com")
    _git(repo, "config", "user.name", "Test")
    (repo / "app.py").write_text("value = 1\n")
    _git(repo, "add", "app.py")
    _git(repo, "commit", "-q", "-m", "baseline")
    _git(repo, "checkout", "-q", "-b", "candidate")
    (repo / "app.py").write_text("value = 2\n")
    _git(repo, "commit", "-q", "-am", "candidate")
    _git(repo, "checkout", "-q", "-")
    return repo


class _Runner:
    """Canned per-side durations, recording every call."""

    def __init__(self, durations: dict[str, list[float]]) -> None:
        self.durations = durations
        self.calls: list[tuple[list[str], Path, dict[str, str]]] = []

    def __call__(self, argv: list[str], cwd: Path, env, timeout: float) -> float:
        self.calls.append((list(argv), cwd, dict(env)))
        side = "baseline" if "baseline" in str(cwd) else "candidate"
        return self.durations[side].pop(0)


def test_prescreen_interleaves_worktrees_and_calls_nonoverlap(repo: Path) -> None:
    workload = _loaded()
    runner = _Runner(
        {
            "baseline": [9.0] + [1.00, 1.02, 1.01, 1.03],
            "candidate": [9.0] + [0.80, 0.82, 0.81, 0.83],
        }
    )

    result = run_prescreen(repo, workload, "main", "candidate", runs=4, warmups=1, runner=runner)

    assert result.verdict == "likely-improvement"
    assert result.relative_delta < -0.15
    assert result.baseline.commit_sha == _git(repo, "rev-parse", "main")
    assert len(result.baseline.seconds) == len(result.candidate.seconds) == 4

    sides = ["baseline" if "baseline" in str(cwd) else "candidate" for _, cwd, _ in runner.calls]
    # One warmup pair, then alternating round order so drift hits both sides.
    assert sides[:2] == ["baseline", "candidate"]
    assert sides[2:] == [
        "baseline",
        "candidate",
        "candidate",
        "baseline",
        "baseline",
        "candidate",
        "candidate",
        "baseline",
    ]

    argv, cwd, env = runner.calls[0]
    assert env["BAKUDO_WORKLOAD_DIR"] == str(workload.root)
    # A plain member reference resolves against the workload directory, so
    # the run works from the worktree without copying the workload into it.
    assert any(argument.startswith(str(workload.root)) for argument in argv[1:])
    assert "baseline" in str(cwd)

    document = result.to_dict()
    assert document["kind"] == "HostPrescreen"
    assert document["evidence"] is False

    # Both disposable worktrees are gone; only the primary checkout remains.
    assert len(_git(repo, "worktree", "list", "--porcelain").split("\n\n")) == 1


def test_prescreen_overlapping_ranges_stay_unclear(repo: Path) -> None:
    runner = _Runner(
        {
            "baseline": [9.0] + [1.00, 1.10, 0.95, 1.05],
            "candidate": [9.0] + [0.98, 1.02, 0.97, 1.08],
        }
    )

    result = run_prescreen(repo, _loaded(), "main", "candidate", runs=4, warmups=1, runner=runner)

    assert result.verdict == "unclear"


def test_prescreen_rejects_an_unknown_ref(repo: Path) -> None:
    with pytest.raises(PrescreenError, match="rev-parse"):
        run_prescreen(repo, _loaded(), "main", "no-such-ref", runner=_Runner({}))


def test_prescreen_cleans_worktrees_when_the_command_fails(repo: Path) -> None:
    def broken(argv, cwd, env, timeout: float) -> float:
        raise PrescreenError("workload command exited 1: boom")

    with pytest.raises(PrescreenError, match="boom"):
        run_prescreen(repo, _loaded(), "main", "candidate", runner=broken)

    assert len(_git(repo, "worktree", "list", "--porcelain").split("\n\n")) == 1
