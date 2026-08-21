"""No-eval product-agent application service.

The service intentionally bypasses ``control.pipeline`` and Temporal's
``AgentRunWorkflow`` because both continue into Bakudo-owned evaluation.  Its
only side effect is one abox run followed by atomic patch/result publication.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import shutil
import time
from collections.abc import Callable
from pathlib import Path
from typing import Protocol

from .. import __version__, ids
from ..abox.runner import AboxError, AboxNotFoundError, AboxOutcome, AboxRunner
from ..agent_run_bundle import AgentRunBundle, budget_from_spec
from ..agent_spec import load_spec_file
from ..agent_spec.models import NetworkMode
from ..curriculum.objective import Objective, ObjectiveType
from ..paths import agents_dir, skills_dir
from .contracts import (
    PatchMetadata,
    ProductAgentReason,
    ProductAgentResult,
    ProductAgentStatus,
    RuntimeMetadata,
    UsageMetadata,
)
from .staging import ProductAgentInputError, publish_output, sha256_bytes, validate_input

DEFAULT_AGENT_NAME = "add-feature"
MAX_PRODUCT_PATCH_BYTES = 16 * 1024 * 1024
SUPPORTED_ABOX_VERSION = "0.7.2"

# These variables can weaken or silently redirect an otherwise identical run.
# Model endpoint variables are deliberately not listed: they are required by
# the packaged AgentSpec and are forwarded through AboxRunner's explicit list.
_FORBIDDEN_AMBIENT_OVERRIDES = (
    "BAKUDO_ABOX_SKIP_VERSION_CHECK",
    "BAKUDO_ALLOW_NETWORK_OPEN",
    "BAKUDO_BASE_REF",
    "BAKUDO_ENV",
    "BAKUDO_OFFLINE",
    "BAKUDO_REPO_ROOT",
    "BAKUDO_SANDBOX",
)
_RESERVED_CHANGED_PREFIXES = (".abox", ".agent")


class SandboxRunner(Protocol):
    def verify_binary(self) -> str: ...

    def run(
        self,
        bundle: AgentRunBundle,
        cancel_event: object | None = None,
    ) -> AboxOutcome: ...


RunnerFactory = Callable[[Path], SandboxRunner]


def _default_runner_factory(workspace: Path) -> SandboxRunner:
    executable = shutil.which("abox")
    if executable is None:
        raise AboxNotFoundError("abox 0.7.2 is not on PATH")
    return AboxRunner(abox_bin=str(Path(executable).resolve()), repo_root=workspace)


def _reject_ambient_overrides() -> None:
    present = [name for name in _FORBIDDEN_AMBIENT_OVERRIDES if name in os.environ]
    present.extend(name for name in os.environ if name.startswith("ABOX_"))
    present = sorted(set(present))
    if present:
        raise ProductAgentInputError(
            "product-agent v1 rejects behavior-weakening ambient overrides: " + ", ".join(present)
        )


def _bundle(workspace: Path, instruction: str, base_commit: str) -> AgentRunBundle:
    spec = load_spec_file(agents_dir() / f"{DEFAULT_AGENT_NAME}.yaml")
    # Product mode fixes the exact base commit and never permits open network.
    # Preserve every other packaged role setting, including its skills/tools.
    spec = spec.model_copy(
        update={
            "sandbox": spec.sandbox.model_copy(
                update={
                    "base_ref": base_commit,
                    "network_mode": NetworkMode.scoped,
                    "max_diff_bytes": min(
                        spec.sandbox.max_diff_bytes
                        if spec.sandbox.max_diff_bytes is not None
                        else MAX_PRODUCT_PATCH_BYTES,
                        MAX_PRODUCT_PATCH_BYTES,
                    ),
                }
            )
        }
    )
    objective = Objective(
        type=ObjectiveType.maintenance,
        repo=str(workspace),
        title="Apply the requested repository change.",
        description=instruction,
        acceptance_criteria=[
            "Implement only the requested change.",
            "Run relevant tests before reporting completion.",
        ],
    )
    return AgentRunBundle(
        run_id=ids.run_id(),
        objective_id=objective.id,
        objective=objective,
        agent_spec=spec,
        budget=budget_from_spec(spec),
    )


def _canonical_digest(value: object) -> str:
    content = json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    ).encode("utf-8")
    return sha256_bytes(content)


def _skills_digest(names: list[str]) -> str:
    digest = hashlib.sha256(b"\0bakudo-product-agent-skills-v1\0")
    root = skills_dir()
    for name in names:
        skill_root = root / name
        if not skill_root.is_dir() or skill_root.is_symlink():
            raise ProductAgentInputError(f"packaged skill is unavailable: {name}")
        digest.update(name.encode("utf-8"))
        digest.update(b"\0")
        files = sorted(
            path
            for path in skill_root.rglob("*")
            if path.is_file()
            and not path.is_symlink()
            and "__pycache__" not in path.parts
            and path.suffix not in {".pyc", ".pyo"}
        )
        for path in files:
            relative = path.relative_to(skill_root).as_posix().encode("utf-8")
            content = path.read_bytes()
            digest.update(len(relative).to_bytes(8, "big"))
            digest.update(relative)
            digest.update(b"x" if path.stat().st_mode & 0o111 else b"-")
            digest.update(len(content).to_bytes(8, "big"))
            digest.update(content)
    return f"sha256:{digest.hexdigest()}"


def _runtime(bundle: AgentRunBundle, abox_version: str) -> RuntimeMetadata:
    return RuntimeMetadata(
        bakudo_version=__version__,
        agent_ref=bundle.agent_spec.ref,
        agent_spec_digest=_canonical_digest(bundle.agent_spec.to_dict()),
        skills_digest=_skills_digest(bundle.agent_spec.skills),
        abox_version=abox_version,
        attested=False,
    )


def _safe_count(value: object) -> int:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return 0
    numeric = float(value)
    if not math.isfinite(numeric) or numeric < 0:
        return 0
    return int(numeric)


def _usage(outcome: AboxOutcome, *, fallback_seconds: float) -> UsageMetadata:
    observed = outcome.observability or {}
    seconds = outcome.runtime_seconds
    if not math.isfinite(seconds) or seconds < 0:
        seconds = fallback_seconds
    return UsageMetadata(
        wall_time_ms=max(0, round(seconds * 1000)),
        tokens=_safe_count(outcome.tokens_used),
        model_calls=_safe_count(observed.get("model_calls", 0)),
        tool_calls=_safe_count(observed.get("tool_calls", 0)),
        denied_commands=len(outcome.denied_commands),
    )


def _terminal(outcome: AboxOutcome) -> tuple[ProductAgentStatus, ProductAgentReason | None]:
    if outcome.timed_out or outcome.exit_code == 124:
        return ProductAgentStatus.timed_out, ProductAgentReason.sandbox_timeout
    if outcome.exit_code == 130:
        return ProductAgentStatus.cancelled, ProductAgentReason.cancelled
    if outcome.error or outcome.result is None:
        if "maximum" in outcome.error or "patch" in outcome.error:
            return ProductAgentStatus.failed, ProductAgentReason.output_policy_violation
        return ProductAgentStatus.failed, ProductAgentReason.sandbox_failed
    result_status = outcome.result.get("status")
    # agent-runner intentionally exits 1 after publishing a valid `failed`
    # result; distinguish that expected terminal from an arbitrary sandbox
    # process failure.
    if result_status == "failed" and outcome.exit_code == 1:
        return ProductAgentStatus.failed, ProductAgentReason.agent_failed
    if outcome.exit_code != 0:
        return ProductAgentStatus.failed, ProductAgentReason.sandbox_failed
    if result_status == "blocked":
        return ProductAgentStatus.blocked, ProductAgentReason.agent_blocked
    if result_status != "success":
        return ProductAgentStatus.failed, ProductAgentReason.sandbox_failed
    return ProductAgentStatus.completed, None


def _has_reserved_changes(changed_files: list[str]) -> bool:
    return any(
        path == prefix or path.startswith(prefix + "/")
        for path in changed_files
        for prefix in _RESERVED_CHANGED_PREFIXES
    )


def _result(
    *,
    run_id: str,
    status: ProductAgentStatus,
    reason: ProductAgentReason | None,
    patch: bytes,
    changed_files: list[str],
    usage: UsageMetadata,
    runtime: RuntimeMetadata,
) -> ProductAgentResult:
    return ProductAgentResult(
        run_id=run_id,
        status=status,
        reason_code=reason,
        patch=PatchMetadata(
            digest=sha256_bytes(patch),
            size_bytes=len(patch),
            changed_files=tuple(sorted(set(changed_files))),
        ),
        usage=usage,
        runtime=runtime,
    )


def run_product_agent(
    *,
    protocol: str,
    workspace: str | Path,
    instruction_file: str | Path,
    output_dir: str | Path,
    cancel_event: object | None = None,
    runner_factory: RunnerFactory | None = None,
) -> ProductAgentResult:
    """Run one pinned packaged agent in abox and publish the v1 artifacts."""

    if protocol != "v1":
        raise ProductAgentInputError(f"unsupported product-agent protocol: {protocol!r}")
    _reject_ambient_overrides()
    validated = validate_input(workspace, instruction_file, output_dir)
    bundle = _bundle(validated.workspace, validated.instruction, validated.base_commit)
    started = time.monotonic()
    runner = (runner_factory or _default_runner_factory)(validated.workspace)
    abox_version = runner.verify_binary()
    if abox_version != SUPPORTED_ABOX_VERSION:
        raise ProductAgentInputError(
            "product-agent v1 requires exact abox version "
            f"{SUPPORTED_ABOX_VERSION}; observed {abox_version!r}"
        )
    runtime = _runtime(bundle, abox_version)

    try:
        outcome = runner.run(bundle, cancel_event=cancel_event)
    except (AboxError, OSError) as exc:
        # A valid no-score terminal artifact is preferable to making the outer
        # harness infer status from stderr.  Exception text remains private.
        _ = exc
        elapsed = time.monotonic() - started
        result = _result(
            run_id=bundle.run_id,
            status=ProductAgentStatus.failed,
            reason=ProductAgentReason.sandbox_unavailable,
            patch=b"",
            changed_files=[],
            usage=UsageMetadata(
                wall_time_ms=max(0, round(elapsed * 1000)),
                tokens=0,
                model_calls=0,
                tool_calls=0,
                denied_commands=0,
            ),
            runtime=runtime,
        )
        publish_output(validated.output_dir, b"", result)
        return result

    elapsed = time.monotonic() - started
    status, reason = _terminal(outcome)
    patch = outcome.patch_bytes
    changed_files = list(outcome.changed_files)
    if status is ProductAgentStatus.completed and _has_reserved_changes(changed_files):
        status = ProductAgentStatus.failed
        reason = ProductAgentReason.output_policy_violation
    if status is not ProductAgentStatus.completed:
        # Never offer a partial/failed candidate for accidental application.
        patch = b""
        changed_files = []
    result = _result(
        run_id=bundle.run_id,
        status=status,
        reason=reason,
        patch=patch,
        changed_files=changed_files,
        usage=_usage(outcome, fallback_seconds=elapsed),
        runtime=runtime,
    )
    publish_output(validated.output_dir, patch, result)
    return result


__all__ = ["ProductAgentInputError", "run_product_agent"]
