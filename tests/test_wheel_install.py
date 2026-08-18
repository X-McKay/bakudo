"""API-12 regression guard: the wheel is a complete, runnable install.

Builds the wheel, installs it into a throwaway venv, and runs the CLI from an
empty working directory — proving the demo, optimization, workload, and
performance surfaces no longer depend on the source tree (which only exists
in development checkouts).

Opt-in because it builds a wheel and creates a venv (`make wheel-smoke`):

    BAKUDO_WHEEL_TESTS=1 pytest tests/test_wheel_install.py
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import venv
from pathlib import Path

import pytest

from bakudo.performance.verify import workload_content_digest

pytestmark = pytest.mark.skipif(
    os.environ.get("BAKUDO_WHEEL_TESTS") != "1",
    reason="wheel-install smoke test; set BAKUDO_WHEEL_TESTS=1 (make wheel-smoke)",
)

REPO_ROOT = Path(__file__).resolve().parents[1]


def _run(argv: list[str], **kwargs) -> subprocess.CompletedProcess:
    return subprocess.run(argv, capture_output=True, text=True, timeout=600, **kwargs)


@pytest.fixture(scope="module")
def wheel_venv(tmp_path_factory) -> Path:
    """A throwaway venv with the freshly built wheel installed."""
    tmp = tmp_path_factory.mktemp("wheel-install")
    dist = tmp / "dist"
    built = _run(
        [sys.executable, "-m", "pip", "wheel", str(REPO_ROOT), "-w", str(dist), "--no-deps", "-q"]
    )
    assert built.returncode == 0, built.stderr
    wheel = next(dist.glob("bakudo-*.whl"))

    venv_dir = tmp / "venv"
    # symlinks=True matches the `python -m venv` CLI default on POSIX; the
    # in-process default (copies) breaks relocatable interpreters whose
    # libpython lives next to the real binary (e.g. mise installs).
    venv.create(venv_dir, with_pip=True, symlinks=(os.name == "posix"))
    installed = _run([str(venv_dir / "bin" / "pip"), "install", "-q", str(wheel)])
    assert installed.returncode == 0, installed.stderr
    return venv_dir


@pytest.fixture()
def clean_cwd(tmp_path, monkeypatch) -> Path:
    """An empty cwd + env so the source tree cannot leak into the run."""
    monkeypatch.delenv("PYTHONPATH", raising=False)
    # Operator config from a sourced .env must not redirect the packaged
    # resources these tests certify (or fail doctor on a foreign pin).
    monkeypatch.delenv("BAKUDO_WORKLOAD_SOURCE", raising=False)
    monkeypatch.delenv("BAKUDO_TASK_SOURCE", raising=False)
    monkeypatch.delenv("BAKUDO_PERFORMANCE_ENVIRONMENT", raising=False)
    monkeypatch.setenv("BAKUDO_OFFLINE", "1")
    return tmp_path


def test_wheel_packages_the_seed_agents(wheel_venv: Path, clean_cwd: Path):
    listed = _run(
        [
            str(wheel_venv / "bin" / "python"),
            "-c",
            "from bakudo.paths import agents_dir; "
            "print(sorted(p.stem for p in agents_dir().glob('*.yaml')))",
        ],
        cwd=clean_cwd,
    )
    assert listed.returncode == 0, listed.stderr
    for name in ("add-feature", "critic", "explore", "optimize-attempt", "optimize-scout", "qa"):
        assert name in listed.stdout


def test_wheel_packages_the_smoke_workload(wheel_venv: Path, clean_cwd: Path):
    listed = _run(
        [
            str(wheel_venv / "bin" / "python"),
            "-c",
            "from bakudo.paths import smoke_workloads_dir; "
            "from bakudo.performance.source import DirectoryWorkloadSource; "
            "print(DirectoryWorkloadSource(smoke_workloads_dir()).list()[0].ref)",
        ],
        cwd=clean_cwd,
    )
    assert listed.returncode == 0, listed.stderr
    assert listed.stdout.strip() == "smoke-python-loop@1.0.0"


def test_wheel_workload_cli_uses_the_packaged_corpus(wheel_venv: Path, clean_cwd: Path):
    bakudo = str(wheel_venv / "bin" / "bakudo")
    listed = _run([bakudo, "workload", "list", "--json"], cwd=clean_cwd)
    assert listed.returncode == 0, listed.stderr
    workloads = json.loads(listed.stdout)
    assert [entry["ref"] for entry in workloads] == ["smoke-python-loop@1.0.0"]
    assert workloads[0]["sourceURI"] == "package://bakudo/smoke-workloads"

    inspected = _run(
        [bakudo, "workload", "inspect", "smoke-python-loop@1.0.0", "--json"],
        cwd=clean_cwd,
    )
    assert inspected.returncode == 0, inspected.stderr
    document = json.loads(inspected.stdout)
    assert document["pin"]["sourceURI"] == "package://bakudo/smoke-workloads"
    # The wheel-installed corpus must pin the same content as the source
    # checkout: any digest drift (e.g. installer byte-compilation caches
    # swept into the bundle) breaks cross-host workload pin verification.
    expected_digest = workload_content_digest(
        REPO_ROOT / "smoke" / "workloads" / "python-loop"
    )
    assert document["pin"]["bundleDigest"] == expected_digest
    assert document["pin"]["executorDigests"][0]["path"] == "run.py"


def test_wheel_exposes_the_performance_cli(wheel_venv: Path, clean_cwd: Path):
    bakudo = str(wheel_venv / "bin" / "bakudo")
    result = _run([bakudo, "performance", "--help"], cwd=clean_cwd)
    assert result.returncode == 0, result.stderr
    # Substring checks against the group help are vacuous ("show" appears in
    # argparse's own "-h, --help" line); prove each subcommand is registered
    # by asking argparse to parse it.
    for command in ("measure", "capture", "compare", "show", "regressions"):
        sub = _run([bakudo, "performance", command, "--help"], cwd=clean_cwd)
        assert sub.returncode == 0, f"{command}: {sub.stderr}"


def test_wheel_bakudo_demo_runs_offline(wheel_venv: Path, clean_cwd: Path):
    # Explicit venv path: a stale `bakudo` elsewhere on PATH must not win.
    demo = _run([str(wheel_venv / "bin" / "bakudo"), "demo"], cwd=clean_cwd)
    assert demo.returncode == 0, demo.stderr
    assert "run_id" in demo.stdout
    assert "phase" in demo.stdout


def test_wheel_bakudo_optimize_help(wheel_venv: Path, clean_cwd: Path):
    result = _run([str(wheel_venv / "bin" / "bakudo"), "optimize", "--help"], cwd=clean_cwd)
    assert result.returncode == 0, result.stderr
    assert "--repo" in result.stdout


def test_wheel_bakudo_doctor_loads_packaged_resources(wheel_venv: Path, clean_cwd: Path):
    result = _run(
        [str(wheel_venv / "bin" / "bakudo"), "doctor", "--json"],
        cwd=clean_cwd,
    )
    assert result.returncode == 0, result.stderr
    report = json.loads(result.stdout)
    assert report["ok"] is True
    assert next(c for c in report["checks"] if c["name"] == "agent-specs")["status"] == "ok"
    assert next(c for c in report["checks"] if c["name"] == "skills")["status"] == "ok"
    assert next(c for c in report["checks"] if c["name"] == "task-source")["status"] == "ok"
