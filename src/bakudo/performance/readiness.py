"""Fail-closed admission checks for latency-decision runners.

An :class:`~bakudo.performance.pins.EnvironmentPin` records the identity of a
measurement environment, but it cannot establish that the process about to
run a workload is an approved performance lab. This module supplies that
separate, explicit operational contract. It is deliberately read-only:
preflight never starts a guest, contacts a service, or writes a ledger row.
"""

from __future__ import annotations

import os
import shutil
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path

from .environment import EnvironmentPinLoadError, configured_environment_pin
from .pins import EnvironmentPin

RUNNER_MODE_ENV = "BAKUDO_PERFORMANCE_RUNNER"
TRUSTED_RUNNER_MODE = "trusted"


class PerformanceRunnerReadinessError(RuntimeError):
    """A process attempted latency evidence without a trusted runner posture."""


@dataclass(frozen=True)
class PerformanceRunnerReadiness:
    """Read-only admission result for a performance decision runner."""

    environment: EnvironmentPin | None
    issues: tuple[str, ...]

    @property
    def ready(self) -> bool:
        return not self.issues

    def to_dict(self) -> dict[str, object]:
        return {
            "ready": self.ready,
            "issues": list(self.issues),
            "environmentDigest": (
                self.environment.environment_digest if self.environment is not None else None
            ),
        }


def inspect_performance_runner(
    *,
    environment: EnvironmentPin | None = None,
    environment_path: str | Path | None = None,
    workload_source: str | Path | None = None,
    abox_bin: str = "abox",
    environ: Mapping[str, str] | None = None,
    find_executable: Callable[[str], str | None] = shutil.which,
) -> PerformanceRunnerReadiness:
    """Inspect the explicit trusted-runner contract without changing state.

    ``environment`` and ``workload_source`` let callers that already resolved
    immutable inputs avoid re-reading them. A GitHub Actions process is
    accepted only when the runner itself identifies as ``self-hosted``; that
    makes a generic hosted runner incapable of producing latency decisions
    even if a workflow accidentally sets the opt-in mode variable.
    """

    values = os.environ if environ is None else environ
    issues: list[str] = []

    if values.get(RUNNER_MODE_ENV) != TRUSTED_RUNNER_MODE:
        issues.append(f"set {RUNNER_MODE_ENV}={TRUSTED_RUNNER_MODE!r} to admit latency decisions")
    if values.get("BAKUDO_SANDBOX") != "abox":
        issues.append("set BAKUDO_SANDBOX=abox; latency decisions cannot use a host runner")
    if not values.get("BAKUDO_POSTGRES_DSN"):
        issues.append("set BAKUDO_POSTGRES_DSN for durable measurement and comparison evidence")

    source = (
        str(workload_source)
        if workload_source is not None
        else values.get("BAKUDO_WORKLOAD_SOURCE")
    )
    if not source:
        issues.append("configure BAKUDO_WORKLOAD_SOURCE or pass an explicit workload source")
    elif source.startswith("package://"):
        issues.append("packaged smoke workloads cannot support latency decisions")

    resolved_environment = environment
    if resolved_environment is None:
        try:
            configured_path = (
                environment_path
                if environment_path is not None
                else values.get("BAKUDO_PERFORMANCE_ENVIRONMENT")
            )
            if configured_path is None:
                raise EnvironmentPinLoadError(
                    "set BAKUDO_PERFORMANCE_ENVIRONMENT or pass an explicit environment pin"
                )
            resolved_environment = configured_environment_pin(configured_path)
        except EnvironmentPinLoadError as exc:
            issues.append(str(exc))

    # shutil.which resolves a bare name against PATH and checks a configured
    # path directly, so an invoker's explicit abox binary is honored here.
    if find_executable(abox_bin) is None:
        issues.append(f"abox binary {abox_bin!r} is not executable; install abox or fix the path")

    if values.get("GITHUB_ACTIONS", "").lower() == "true":
        runner_environment = values.get("RUNNER_ENVIRONMENT")
        if runner_environment != "self-hosted":
            issues.append(
                "GitHub Actions latency decisions require RUNNER_ENVIRONMENT=self-hosted; "
                "generic GitHub-hosted runners are forbidden"
            )

    return PerformanceRunnerReadiness(
        environment=resolved_environment,
        issues=tuple(issues),
    )


def require_trusted_performance_runner(
    *,
    environment: EnvironmentPin | None = None,
    environment_path: str | Path | None = None,
    workload_source: str | Path | None = None,
    abox_bin: str = "abox",
) -> EnvironmentPin:
    """Return the exact pin only when this process may create latency evidence."""

    readiness = inspect_performance_runner(
        environment=environment,
        environment_path=environment_path,
        workload_source=workload_source,
        abox_bin=abox_bin,
    )
    if not readiness.ready:
        raise PerformanceRunnerReadinessError(
            "trusted performance-runner preflight failed: " + "; ".join(readiness.issues)
        )
    assert readiness.environment is not None
    return readiness.environment
