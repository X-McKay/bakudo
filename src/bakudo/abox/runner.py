"""Drive a real ``abox`` (0.6.0) sandbox run for a task bundle (spec section 6).

This is invoked from a Temporal *activity* (non-deterministic external work),
never from workflow code. Protocol, verified against the abox 0.6.0 CLI:

1. the rendered ``bundle.json`` is written to a host scratch dir and staged
   into the guest via ``--input-file`` (it appears read-only under
   ``/abox-meta/inputs/``);
2. the guest command is ``python3 -m bakudo.runner.main --bundle
   /abox-meta/inputs/bundle.json --result /workspace/.agent/result.json``
   (the module form of the ``agent-runner`` entrypoint; pip's user bin where
   the prepare flow installs console scripts is off the fixed guest PATH);
3. abox forks branch ``agent/<task>`` from ``--base`` into a host worktree;
   after the run the worktree is resolved with ``abox path <task>`` and
   ``<worktree>/.agent/result.json`` is collected and schema-validated;
4. the diff (including untracked files) is computed host-side from the
   worktree before cleanup;
5. the sandbox is always torn down with ``abox stop --clean <task>`` so a
   Temporal retry of the same run id never collides with a stale
   worktree/branch (review finding ABOX-8).

Environment forwarding (review finding ABOX-5): the model-endpoint variables
(``VLLM_BASE_URL``, ``VLLM_API_KEY``, every ``BAKUDO_VLLM_*``) plus
``BAKUDO_OFFLINE`` are forwarded from the *worker process environment* by name
via ``-e``. Secret values are never written into files this module creates and
never logged; they only transit the abox argv, which this module never echoes.

Network mapping (review finding ABOX-6): the spec vocabulary is
``none|scoped|open``; abox 0.6.0 takes ``--network safe|scoped|open``. ``none``
maps to ``safe`` (loopback-only guest), the other two map verbatim. Scoped
*bundles/domains* cannot be granted per-run in 0.6.0 — they are repo-owned
config in ``.abox/project.toml`` — so the spec's ``networkBundles`` are not
placed on the argv; the run-level ``--network`` can only narrow, never widen,
what the trusted project config allows.

Repo routing (review finding ABOX-7): ``objective.repo`` is a bare name. It is
resolved under ``repo_root`` (constructor arg, else ``$BAKUDO_REPO_ROOT``, else
the worker's cwd): ``<repo_root>/<name>`` when that is a git checkout,
otherwise ``repo_root`` itself is assumed to be the repo. The resolved path is
passed to every abox invocation via ``--repo``.

The canonical run id is reused as the abox task id (spec section 6.3).
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

from .. import ids
from ..bundle import TaskBundle
from ..schema import SchemaValidationError, validate_result

# An executor runs the argv (with a kill timeout in seconds) and returns an
# ExecResult. Swappable so tests and dry-runs need not have abox installed.
Executor = Callable[..., "ExecResult"]

# Extra wall clock granted to the abox process beyond the sandbox --timeout:
# boot, prepare refresh, and teardown happen outside the guest deadline.
SUBPROCESS_TIMEOUT_HEADROOM_SECONDS = 120

# Timeout for the short bookkeeping calls (abox path / abox stop).
_HOUSEKEEPING_TIMEOUT_SECONDS = 120

# How many characters of console output to keep for diagnostics (ABOX-11).
_TAIL_CHARS = 20_000

# Spec networkMode -> abox 0.6.0 --network value (ABOX-6).
NETWORK_MODE_MAP = {"none": "safe", "scoped": "scoped", "open": "open"}

# Env var names forwarded from the worker process into the guest, by name.
_FORWARD_ENV = ("BAKUDO_OFFLINE", "VLLM_BASE_URL", "VLLM_API_KEY")
_FORWARD_ENV_PREFIX = "BAKUDO_VLLM_"

# Observability counters mirrored from result.json metrics (ABOX-10); written
# by runner/main.py, numeric because result.schema.json only allows numbers.
_OBSERVABILITY_METRIC_KEYS = (
    "tool_calls",
    "model_calls",
    "tokens_used",
    "memories_retrieved",
    "denied_commands",
    "runtime_seconds",
)


class AboxError(RuntimeError):
    """A failure driving the abox CLI."""


class AboxNotFoundError(AboxError):
    """The abox binary is not installed/resolvable on this worker."""


@dataclass
class ExecResult:
    exit_code: int
    stdout: str = ""
    stderr: str = ""
    timed_out: bool = False


@dataclass(frozen=True)
class SandboxProfile:
    """A bakudo sandbox policy profile (spec section 6.4).

    Note: these are *bakudo policy* profiles consumed by the in-guest tool
    layer, never abox ``--template`` names (review finding ABOX-3). The guest
    OS profile (e.g. ``python-glibc``) is repo-owned ``.abox/project.toml``
    config.
    """

    name: str
    network_mode: str = "scoped"
    network_bundles: tuple[str, ...] = ()
    allowed_commands: tuple[str, ...] = ()
    max_changed_files: int | None = None
    max_diff_bytes: int | None = None
    can_merge: bool = False
    ephemeral: bool = True
    max_runtime_seconds: int = 3600


# The starter profiles named in the spec (section 6.4).
PROFILES: dict[str, SandboxProfile] = {
    "explore-readonly": SandboxProfile(
        name="explore-readonly", network_mode="none", can_merge=False, ephemeral=True
    ),
    "add-feature-python": SandboxProfile(
        name="add-feature-python",
        network_bundles=("pypi-public",),
        max_changed_files=20,
        can_merge=False,
        ephemeral=False,
    ),
    "qa-candidate-branch": SandboxProfile(
        name="qa-candidate-branch", can_merge=False, ephemeral=False
    ),
    "skill-author": SandboxProfile(
        name="skill-author", can_merge=False, ephemeral=False
    ),
    "restricted-network": SandboxProfile(
        name="restricted-network", network_mode="none", ephemeral=True
    ),
    "optimize-python": SandboxProfile(
        name="optimize-python",
        network_bundles=("pypi-public",),
        max_changed_files=10,
        can_merge=False,
        ephemeral=False,
    ),
}


@dataclass
class AboxOutcome:
    """Everything collected from a finished sandbox run."""

    run_id: str
    abox_task_id: str
    exit_code: int
    git_branch: str
    result: dict | None = None
    diff: str = ""
    changed_files: list[str] = field(default_factory=list)
    denied_commands: list[dict[str, str]] = field(default_factory=list)
    runtime_seconds: float = 0.0
    tokens_used: int = 0
    observability: dict = field(default_factory=dict)
    stdout: str = ""
    stderr: str = ""
    timed_out: bool = False
    error: str = ""

    @property
    def succeeded(self) -> bool:
        return self.exit_code == 0 and self.result is not None and not self.timed_out


def _tail(text: str) -> str:
    return text[-_TAIL_CHARS:]


def _subprocess_executor(
    argv: list[str], timeout: float | None = None
) -> ExecResult:
    """Run abox for real, mapping a host-side kill to exit 124 (ABOX-11)."""
    try:
        proc = subprocess.run(argv, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired as expired:
        out = expired.stdout or b""
        err = expired.stderr or b""
        return ExecResult(
            124,
            out.decode(errors="replace") if isinstance(out, bytes) else out,
            err.decode(errors="replace") if isinstance(err, bytes) else err,
            timed_out=True,
        )
    return ExecResult(proc.returncode, proc.stdout, proc.stderr)


class AboxRunner:
    """Builds and drives a single abox 0.6.0 sandbox run for a task bundle."""

    def __init__(
        self,
        *,
        abox_bin: str = "abox",
        repo_root: Path | str | None = None,
        guest_bundle_path: str = "/abox-meta/inputs/bundle.json",
        result_relpath: str = ".agent/result.json",
        executor: Executor | None = None,
        scratch_root: Path | None = None,
    ) -> None:
        self._abox_bin = abox_bin
        self._repo_root = Path(repo_root) if repo_root is not None else None
        self._guest_bundle_path = guest_bundle_path
        self._result_relpath = result_relpath
        self._executor: Executor = executor or _subprocess_executor
        self._scratch_root = scratch_root

    # -- routing -----------------------------------------------------------

    def resolve_repo(self, bundle: TaskBundle) -> Path:
        """Resolve ``objective.repo`` (a bare name) to a host repo path (ABOX-7)."""
        root = self._repo_root
        if root is None:
            env_root = os.environ.get("BAKUDO_REPO_ROOT")
            root = Path(env_root) if env_root else Path.cwd()
        candidate = root / bundle.objective.repo
        if (candidate / ".git").exists():
            return candidate
        return root

    # -- command construction ---------------------------------------------

    @staticmethod
    def _forwarded_env() -> list[str]:
        """Names (and current values) of model env vars to forward (ABOX-5).

        Only variables actually present in the worker environment are
        forwarded; nothing is ever defaulted or persisted to disk.
        """
        names = [name for name in _FORWARD_ENV if name in os.environ]
        names += sorted(
            name for name in os.environ if name.startswith(_FORWARD_ENV_PREFIX)
        )
        return names

    def build_command(
        self, bundle: TaskBundle, scratch_dir: Path, repo: Path | None = None
    ) -> list[str]:
        """Construct the abox 0.6.0 ``run`` argv (spec section 6.2)."""
        spec = bundle.agent_spec
        repo = repo or self.resolve_repo(bundle)
        network = NETWORK_MODE_MAP[spec.sandbox.network_mode.value]

        argv = [
            self._abox_bin, "run",
            "--repo", str(repo),
            "--task", bundle.run_id,
            "--base", spec.sandbox.base_ref,
            "--timeout", str(spec.sandbox.timeout_seconds),
            "--network", network,
        ]
        # Never `--ephemeral`: abox would remove the worktree+branch the moment
        # the agent exits, before result.json can be collected via `abox path`.
        # Spec ephemerality is honoured by the unconditional post-collection
        # `abox stop --clean` in run()'s finally block instead.
        argv += ["--input-file", f"{scratch_dir / 'bundle.json'}:bundle.json"]
        for name in self._forwarded_env():
            argv += ["-e", f"{name}={os.environ[name]}"]
        argv += [
            "--",
            # Equivalent to the `agent-runner` console script, but PATH-proof:
            # in the 0.6.0 guest the pip *user* bin (~/.local/bin) where the
            # prepare flow's editable install drops console scripts is not on
            # the fixed guest PATH, while `python3 -m` resolves through user
            # site-packages regardless (verified in-guest).
            "python3", "-m", "bakudo.runner.main",
            "--bundle", self._guest_bundle_path,
            "--result", "/workspace/.agent/result.json",
        ]
        return argv

    # -- lifecycle ---------------------------------------------------------

    def run(self, bundle: TaskBundle) -> AboxOutcome:
        started = time.monotonic()
        if self._scratch_root is not None:
            self._scratch_root.mkdir(parents=True, exist_ok=True)
        scratch = Path(
            tempfile.mkdtemp(prefix=f"{bundle.run_id}-", dir=self._scratch_root)
        )
        repo = self.resolve_repo(bundle)
        spec = bundle.agent_spec
        try:
            (scratch / "bundle.json").write_text(
                json.dumps(bundle.model_dump(by_alias=True, mode="json"), indent=2)
            )
            argv = self.build_command(bundle, scratch, repo)
            timeout = spec.sandbox.timeout_seconds + SUBPROCESS_TIMEOUT_HEADROOM_SECONDS
            try:
                exec_result = self._executor(argv, timeout)
            except FileNotFoundError as missing:
                raise AboxNotFoundError(
                    f"abox binary not found: {self._abox_bin!r} is not on PATH "
                    "(install abox 0.6.0 or set AboxRunner(abox_bin=...))."
                ) from missing

            timed_out = exec_result.timed_out or exec_result.exit_code == 124
            errors: list[str] = []
            if timed_out:
                errors.append(
                    f"sandbox timed out (abox --timeout {spec.sandbox.timeout_seconds}s)"
                )

            result: dict | None = None
            diff = ""
            changed_files: list[str] = []
            worktree = self._resolve_worktree(bundle.run_id, repo)
            if worktree is None:
                errors.append("abox path did not resolve a worktree for this task")
            else:
                result, collect_error = self._collect_result(worktree)
                if collect_error:
                    errors.append(collect_error)
                diff, changed_files = self._collect_diff(
                    worktree, spec.sandbox.base_ref
                )

            outcome = AboxOutcome(
                run_id=bundle.run_id,
                abox_task_id=bundle.run_id,
                exit_code=exec_result.exit_code,
                git_branch=ids.git_branch_for(bundle.run_id),
                result=result,
                diff=diff,
                changed_files=changed_files or (result or {}).get("changed_files", []),
                runtime_seconds=time.monotonic() - started,
                stdout=_tail(exec_result.stdout),
                stderr=_tail(exec_result.stderr),
                timed_out=timed_out,
                error="; ".join(errors),
            )
            self._apply_result_signals(outcome)
            return outcome
        finally:
            # Always tear down: a retried run id must never collide with a
            # stale worktree/branch (ABOX-8). Ephemeral sandboxes are already
            # gone; stop --clean is then a no-op.
            self._stop_clean(bundle.run_id, repo)
            shutil.rmtree(scratch, ignore_errors=True)

    def _stop_clean(self, task: str, repo: Path) -> None:
        try:
            self._executor(
                [self._abox_bin, "stop", "--clean", task, "--repo", str(repo)],
                _HOUSEKEEPING_TIMEOUT_SECONDS,
            )
        except (OSError, subprocess.SubprocessError):
            # Best-effort cleanup; the run outcome is already decided.
            pass

    # -- collection --------------------------------------------------------

    def _resolve_worktree(self, task: str, repo: Path) -> Path | None:
        """Resolve the host worktree via ``abox path <task>`` (ABOX-2)."""
        try:
            result = self._executor(
                [self._abox_bin, "path", task, "--repo", str(repo)],
                _HOUSEKEEPING_TIMEOUT_SECONDS,
            )
        except (OSError, subprocess.SubprocessError):
            return None
        if result.exit_code != 0:
            return None
        path = Path(result.stdout.strip())
        return path if path.is_dir() else None

    def _collect_result(self, worktree: Path) -> tuple[dict | None, str]:
        """Read and schema-validate ``<worktree>/.agent/result.json``."""
        candidate = worktree / self._result_relpath
        if not candidate.is_file():
            return None, f"no result.json at {candidate}"
        try:
            document = json.loads(candidate.read_text())
        except json.JSONDecodeError as exc:
            return None, f"result.json is not valid JSON: {exc}"
        try:
            validate_result(document)
        except SchemaValidationError as exc:
            return None, f"result.json failed result.schema.json validation: {exc}"
        return document, ""

    @staticmethod
    def _collect_diff(worktree: Path, base_ref: str) -> tuple[str, list[str]]:
        """Diff the worktree against base, untracked files included (ABOX-9/10).

        ``git diff <base>`` covers committed *and* uncommitted tracked changes
        (the guest agent does not necessarily commit); untracked files are
        appended via ``git diff --no-index`` so create-only work is visible to
        ``maxChangedFiles`` gates and diff-based evals.
        """

        def git(*args: str) -> subprocess.CompletedProcess:
            return subprocess.run(
                ["git", "-C", str(worktree), *args],
                capture_output=True, text=True, timeout=120,
            )

        try:
            parts = [git("diff", "--no-color", base_ref).stdout]
            changed = [
                line
                for line in git("diff", "--name-only", base_ref).stdout.splitlines()
                if line.strip()
            ]
            untracked_proc = git("ls-files", "--others", "--exclude-standard")
            for name in untracked_proc.stdout.splitlines():
                name = name.strip()
                # The runner's own metadata (result.json et al.) is not a change.
                if not name or name.startswith(".agent/"):
                    continue
                changed.append(name)
                parts.append(
                    git("diff", "--no-color", "--no-index", "--", "/dev/null", name).stdout
                )
            return "".join(parts), sorted(set(changed))
        except (OSError, subprocess.SubprocessError):
            return "", []

    @staticmethod
    def _apply_result_signals(outcome: AboxOutcome) -> None:
        """Mirror guest-reported observability out of result.json (ABOX-10)."""
        if not outcome.result:
            return
        metrics = outcome.result.get("metrics") or {}
        observability = {
            key: metrics[key] for key in _OBSERVABILITY_METRIC_KEYS if key in metrics
        }
        if observability:
            outcome.observability = observability
        outcome.tokens_used = int(metrics.get("tokens_used", 0))
        denied_prefix = "denied:"
        outcome.denied_commands = [
            {"command": "", "reason": reason[len(denied_prefix):]}
            for reason in outcome.result.get("blocked_reasons", [])
            if isinstance(reason, str) and reason.startswith(denied_prefix)
        ]
