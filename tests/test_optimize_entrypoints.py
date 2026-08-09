"""The optimize CLI command (offline, end-to-end) and its argument plumbing."""

from __future__ import annotations

from bakudo.cli import main


def test_cli_optimize_runs_offline_end_to_end(capsys, monkeypatch):
    monkeypatch.setenv("BAKUDO_OFFLINE", "1")
    rc = main(
        [
            "optimize",
            "--repo", "bakudo",
            "--title", "Optimize the schema validator",
            "--target", "src/bakudo/schema.py",
            "--rounds", "1",
        ]
    )
    out = capsys.readouterr().out
    assert rc == 0
    # The offline scout is *blocked* (no model) with no followups: since issue
    # #27 that is a scout failure — it must not masquerade as the "code is
    # already optimal" no-change outcome. The CLI still completes (rc 0).
    assert "status      : scout-failed" in out
    assert "rounds used : 1" in out


def test_cli_optimize_threads_constraints_into_the_loop(monkeypatch, capsys):
    captured: dict = {}

    def fake_loop(objective, scout_spec, attempt_spec, **kwargs):
        captured["objective"] = objective
        captured["kwargs"] = kwargs
        return {"status": "no-change", "rounds_used": 1, "reason": "stub"}

    monkeypatch.setattr("bakudo.control.optimize.run_optimize_loop", fake_loop)
    rc = main(
        [
            "optimize",
            "--repo", "payments-api",
            "--title", "Optimize dedup",
            "--bench", "pytest tests/benchmarks -q",
            "--target", "src/ledger/**",
            "--max-files", "3",
            "--rounds", "4",
            "--approaches", "5",
        ]
    )
    assert rc == 0
    objective = captured["objective"]
    assert objective.type.value == "optimize"
    assert objective.constraints.bench_command == "pytest tests/benchmarks -q"
    assert objective.constraints.target_paths == ["src/ledger/**"]
    assert objective.constraints.max_files_changed == 3
    assert captured["kwargs"]["max_rounds"] == 4
    assert captured["kwargs"]["max_approaches"] == 5


def test_cli_optimize_resolves_sandbox_when_live(monkeypatch, capsys):
    """BAKUDO_OFFLINE=0 must route CLI attempts through the fail-closed
    sandbox resolution (same as the API after OPT-10), never the implicit
    in-process local sandbox."""
    import bakudo.cli as cli
    from bakudo.temporal._impl import Deps

    captured = {}

    def fake_loop(objective, scout, attempt, **kw):
        captured.update(kw)
        return {"status": "no-change", "rounds_used": 1, "reason": "test"}

    monkeypatch.setattr("bakudo.control.optimize.run_optimize_loop", fake_loop)
    monkeypatch.setenv("BAKUDO_OFFLINE", "0")
    monkeypatch.setenv("BAKUDO_SANDBOX", "abox")
    rc = cli.main(["optimize", "--repo", "r", "--title", "t"])
    assert rc == 0
    expected = Deps(memory=None).sandbox_fn()
    assert captured.get("sandbox") is not None
    got = getattr(captured["sandbox"], "__qualname__", "")
    assert got == getattr(expected, "__qualname__", "x")


def test_cli_optimize_live_abox_wires_bench_verification(monkeypatch):
    """Issue #28: live abox runs must independently re-bench the winner —
    the CLI passes a fresh-sandbox bench_measure into the loop."""
    import bakudo.cli as cli

    captured = {}

    def fake_loop(objective, scout, attempt, **kw):
        captured.update(kw)
        return {"status": "no-change", "rounds_used": 1, "reason": "test"}

    monkeypatch.setattr("bakudo.control.optimize.run_optimize_loop", fake_loop)
    monkeypatch.setenv("BAKUDO_OFFLINE", "0")
    monkeypatch.setenv("BAKUDO_SANDBOX", "abox")
    rc = cli.main(["optimize", "--repo", "r", "--title", "t"])
    assert rc == 0
    assert captured.get("bench_measure") is not None


def test_cli_optimize_offline_has_no_bench_verifier(monkeypatch, capsys):
    captured = {}

    def fake_loop(objective, scout, attempt, **kw):
        captured.update(kw)
        return {"status": "no-change", "rounds_used": 1, "reason": "test"}

    monkeypatch.setattr("bakudo.control.optimize.run_optimize_loop", fake_loop)
    monkeypatch.setenv("BAKUDO_OFFLINE", "1")
    rc = main(["optimize", "--repo", "r", "--title", "t"])
    assert rc == 0
    assert captured.get("bench_measure") is None


def test_cli_optimize_live_without_sandbox_fails_closed(monkeypatch):
    import bakudo.cli as cli

    monkeypatch.setenv("BAKUDO_OFFLINE", "0")
    monkeypatch.delenv("BAKUDO_SANDBOX", raising=False)
    rc = cli.main(["optimize", "--repo", "r", "--title", "t"])
    assert rc != 0
