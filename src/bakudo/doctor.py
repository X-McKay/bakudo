"""Read-only diagnostics for the local Bakudo developer environment."""

from __future__ import annotations

import importlib.util
import os
import platform
import shutil
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from . import __version__

CheckStatus = Literal["ok", "warning", "error"]


@dataclass(frozen=True)
class DiagnosticCheck:
    """One independently testable environment check."""

    name: str
    status: CheckStatus
    detail: str

    def to_dict(self) -> dict[str, str]:
        return {"name": self.name, "status": self.status, "detail": self.detail}


@dataclass(frozen=True)
class DoctorReport:
    """Aggregate local readiness without contacting external services."""

    checks: tuple[DiagnosticCheck, ...]

    @property
    def ok(self) -> bool:
        return all(check.status != "error" for check in self.checks)

    @property
    def warning_count(self) -> int:
        return sum(check.status == "warning" for check in self.checks)

    @property
    def error_count(self) -> int:
        return sum(check.status == "error" for check in self.checks)

    def to_dict(self) -> dict[str, object]:
        return {
            "ok": self.ok,
            "warnings": self.warning_count,
            "errors": self.error_count,
            "checks": [check.to_dict() for check in self.checks],
        }


def _python_check() -> DiagnosticCheck:
    version = platform.python_version()
    if sys.version_info < (3, 11):  # noqa: UP036 - useful for copied/unpacked installs
        return DiagnosticCheck("python", "error", f"Python {version}; Bakudo requires 3.11+")
    return DiagnosticCheck("python", "ok", f"Python {version}")


def _agent_check() -> DiagnosticCheck:
    from .agent_spec import load_spec_file
    from .paths import agents_dir

    try:
        paths = sorted(agents_dir().glob("*.yaml"))
        specs = [load_spec_file(path) for path in paths]
    except Exception as exc:  # noqa: BLE001 - diagnostics must report all failures
        return DiagnosticCheck("agent-specs", "error", str(exc))
    if not specs:
        return DiagnosticCheck("agent-specs", "error", "no AgentSpec YAML files found")
    refs = ", ".join(spec.ref for spec in specs)
    return DiagnosticCheck("agent-specs", "ok", f"{len(specs)} valid ({refs})")


def _skill_check() -> DiagnosticCheck:
    from .skills import SkillRegistry

    try:
        manifest = SkillRegistry().discovery_manifest()
    except Exception as exc:  # noqa: BLE001 - diagnostics must report all failures
        return DiagnosticCheck("skills", "error", str(exc))
    if not manifest:
        return DiagnosticCheck("skills", "error", "no runtime skills discovered")
    names = ", ".join(entry["name"] for entry in manifest)
    return DiagnosticCheck("skills", "ok", f"{len(manifest)} discovered ({names})")


def _task_source_check() -> DiagnosticCheck:
    from .tasks import default_task_source

    try:
        source = default_task_source()
        tasks = source.list(partitions=None)
    except Exception as exc:  # noqa: BLE001 - diagnostics must report all failures
        return DiagnosticCheck("task-source", "error", str(exc))
    if not tasks:
        return DiagnosticCheck(
            "task-source",
            "error",
            f"no tasks discovered from {source.source_uri}",
        )
    return DiagnosticCheck(
        "task-source",
        "ok",
        f"{len(tasks)} tasks; revision={source.corpus_revision}; source={source.source_uri}",
    )


def _workload_source_check() -> DiagnosticCheck:
    from .performance.source import default_workload_source

    try:
        source = default_workload_source()
        workloads = source.list()
    except Exception as exc:  # noqa: BLE001 - diagnostics report all failures
        return DiagnosticCheck("workload-source", "error", str(exc))
    if not workloads:
        return DiagnosticCheck(
            "workload-source", "error", f"no workloads discovered from {source.source_uri}"
        )
    configured = os.environ.get("BAKUDO_WORKLOAD_SOURCE")
    source_kind = "configured corpus" if configured else "packaged smoke fallback"
    return DiagnosticCheck(
        "workload-source",
        "ok" if configured else "warning",
        f"{len(workloads)} valid; {source_kind}; revision={source.collection_revision}; "
        f"source={source.source_uri}",
    )


def _artifact_store_check() -> DiagnosticCheck:
    configured = os.environ.get("BAKUDO_ARTIFACT_ROOT")
    if not configured:
        return DiagnosticCheck(
            "performance-artifacts",
            "warning",
            "in-memory only; set BAKUDO_ARTIFACT_ROOT to retain raw profiles",
        )
    root = Path(configured).expanduser()
    if not root.exists():
        parent = root.parent
        if parent.is_dir() and os.access(parent, os.W_OK):
            return DiagnosticCheck(
                "performance-artifacts",
                "ok",
                f"local content-addressed store will be created at {root}",
            )
        return DiagnosticCheck(
            "performance-artifacts",
            "error",
            f"artifact root does not exist and parent is not writable: {root}",
        )
    if not root.is_dir() or not os.access(root, os.R_OK | os.W_OK):
        return DiagnosticCheck(
            "performance-artifacts",
            "error",
            f"artifact root must be a readable, writable directory: {root}",
        )
    return DiagnosticCheck(
        "performance-artifacts", "ok", f"local content-addressed store at {root.resolve()}"
    )


def _performance_runner_check() -> DiagnosticCheck:
    binary = shutil.which("abox")
    if binary is None:
        return DiagnosticCheck(
            "performance-runner",
            "warning",
            "abox is unavailable; workload inspection works, but live measurement does not",
        )
    return DiagnosticCheck(
        "performance-runner", "ok", f"trusted uninstrumented runner available: {binary}"
    )


def _performance_readiness_check() -> DiagnosticCheck:
    """Report, but do not implicitly admit, the latency-decision posture."""

    from .performance.readiness import RUNNER_MODE_ENV, inspect_performance_runner

    readiness = inspect_performance_runner()
    if readiness.ready:
        assert readiness.environment is not None
        return DiagnosticCheck(
            "performance-readiness",
            "ok",
            "trusted latency-decision runner admitted; "
            f"environment={readiness.environment.environment_digest}",
        )
    # Ordinary development and generic CI do not run target benchmarks. They
    # remain diagnostically healthy but are visibly ineligible. An operator
    # who explicitly claims trusted mode gets an error for an incomplete or
    # unsafe contract, making bootstrap mistakes fail closed.
    status: CheckStatus = "error" if os.environ.get(RUNNER_MODE_ENV) else "warning"
    return DiagnosticCheck(
        "performance-readiness",
        status,
        "not admitted for latency decisions: " + "; ".join(readiness.issues),
    )


def _performance_environment_check() -> DiagnosticCheck:
    from .performance.environment import configured_environment_pin

    configured = os.environ.get("BAKUDO_PERFORMANCE_ENVIRONMENT")
    if not configured:
        return DiagnosticCheck(
            "performance-environment",
            "warning",
            "no default EnvironmentPin; pass --environment or set "
            "BAKUDO_PERFORMANCE_ENVIRONMENT before measuring",
        )
    try:
        environment = configured_environment_pin()
    except Exception as exc:  # noqa: BLE001 - diagnostics report all failures
        return DiagnosticCheck("performance-environment", "error", str(exc))
    return DiagnosticCheck(
        "performance-environment",
        "ok",
        f"profile={environment.profile}; hardware={environment.hardware_class}; "
        f"digest={environment.environment_digest}",
    )


def _profiler_check() -> DiagnosticCheck:
    py_spy = shutil.which("py-spy")
    if py_spy is None:
        return DiagnosticCheck(
            "performance-profilers",
            "warning",
            "process resources available; Python uses higher-overhead cProfile fallback; "
            "install py-spy in the abox image for sampling",
        )
    return DiagnosticCheck(
        "performance-profilers",
        "warning",
        f"process resources available; py-spy found at {py_spy}, but guest permission "
        "must be verified before sampling is marked available",
    )


def _optional_dependencies_check() -> DiagnosticCheck:
    modules = {
        "api": "fastapi",
        "database": "psycopg",
        "graph": "falkordb",
        "runtime": "strands",
        "temporal": "temporalio",
    }
    missing = [
        label for label, module in modules.items() if importlib.util.find_spec(module) is None
    ]
    if missing:
        return DiagnosticCheck(
            "optional-dependencies",
            "warning",
            f"missing {', '.join(missing)} extras; install `.[all,dev]` for the full test surface",
        )
    return DiagnosticCheck("optional-dependencies", "ok", "all integration extras importable")


def _execution_check() -> DiagnosticCheck:
    offline = os.environ.get("BAKUDO_OFFLINE", "1")
    if offline not in {"0", "1"}:
        return DiagnosticCheck(
            "execution",
            "error",
            f"BAKUDO_OFFLINE must be 0 or 1, got {offline!r}",
        )
    if offline == "1":
        return DiagnosticCheck("execution", "ok", "offline mode; no model or sandbox required")

    sandbox = os.environ.get("BAKUDO_SANDBOX")
    if sandbox == "abox":
        binary = shutil.which("abox")
        if binary is None:
            return DiagnosticCheck(
                "execution",
                "error",
                "live mode selects abox, but the abox executable is not on PATH",
            )
        return DiagnosticCheck("execution", "ok", f"live abox mode; executable={binary}")
    if sandbox == "local" and os.environ.get("BAKUDO_ENV") == "dev":
        return DiagnosticCheck(
            "execution",
            "warning",
            "live local mode executes repository code on the host; use only for development",
        )
    if sandbox == "local":
        return DiagnosticCheck(
            "execution",
            "error",
            "BAKUDO_SANDBOX=local requires BAKUDO_ENV=dev",
        )
    if sandbox is None:
        return DiagnosticCheck(
            "execution",
            "error",
            "live mode requires BAKUDO_SANDBOX=abox or dev-only local",
        )
    return DiagnosticCheck("execution", "error", f"unknown BAKUDO_SANDBOX value {sandbox!r}")


def _persistence_check() -> DiagnosticCheck:
    if os.environ.get("BAKUDO_POSTGRES_DSN"):
        return DiagnosticCheck("persistence", "ok", "Postgres ledger configured")
    return DiagnosticCheck(
        "persistence",
        "warning",
        "in-memory ledger; CLI state does not persist across processes",
    )


def build_doctor_report() -> DoctorReport:
    """Inspect local readiness without connecting to Postgres or other services."""
    checks = (
        _python_check(),
        DiagnosticCheck("bakudo", "ok", f"version {__version__}"),
        _agent_check(),
        _skill_check(),
        _task_source_check(),
        _workload_source_check(),
        _artifact_store_check(),
        _performance_runner_check(),
        _performance_readiness_check(),
        _performance_environment_check(),
        _profiler_check(),
        _optional_dependencies_check(),
        _execution_check(),
        _persistence_check(),
    )
    return DoctorReport(checks)
