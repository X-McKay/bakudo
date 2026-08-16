"""Drive a real ``abox`` (0.7.1) sandbox run for a task bundle (spec section 6).

This is invoked from a Temporal *activity* (non-deterministic external work),
never from workflow code. Protocol, verified against the abox 0.7.1 CLI
(MicroSandbox runtime, ADR-008):

1. the rendered ``bundle.json`` is written to a host scratch dir and staged
   into the guest via ``--input-file`` (it appears read-only under
   ``/abox-meta/inputs/``);
2. the guest command first runs the repo's ``.abox/prepare.sh`` (when present
   in the worktree) and then ``exec``\\ s ``python3 -m bakudo.runner.main
   --bundle /abox-meta/inputs/bundle.json --result
   /workspace/.agent/result.json``. Under 0.7.0 every run sandbox boots a
   fresh OCI-image guest — ``abox env warm`` persists only the declared
   durable caches (e.g. the pip download cache), *not* installed
   site-packages, so the editable install must happen in-run (the warm cache
   keeps it fast). ``python3 -m`` is used rather than the ``agent-runner``
   console script so the invocation works whether pip lands the script on or
   off the guest PATH;
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
``none|scoped|open``; abox 0.7.1 takes ``--network safe|scoped|open``. ``none``
maps to ``safe`` (host-mediated egress only), the other two map verbatim.
Scoped *bundles/domains* cannot be granted per-run — they are repo-owned
config in ``.abox/project.toml`` — so the spec's ``networkBundles`` are not
placed on the argv. Note the run-level ``--network`` *replaces* the project
default for that run (verified against ``effective_network_scope`` in
abox-core): a spec asking for ``open`` on a ``scoped`` repo does widen egress
to abox's public-internet-only mode (host/private/metadata ranges stay
denied); it is not a narrowing-only control. ``build_command`` therefore
refuses ``open`` unless the operator sets ``BAKUDO_ALLOW_NETWORK_OPEN=1``.

Repo routing (review finding ABOX-7): ``objective.repo`` is a bare name. It is
resolved under ``repo_root`` (constructor arg, else ``$BAKUDO_REPO_ROOT``, else
the worker's cwd): ``<repo_root>/<name>`` when that is a git checkout,
otherwise ``repo_root`` itself is assumed to be the repo. The resolved path is
passed to every abox invocation via ``--repo``.

The canonical run id is reused as the abox task id (spec section 6.3).
"""

from __future__ import annotations

import json
import logging
import os
import re
import shutil
import subprocess
import tempfile
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

from .. import ids
from ..agent_spec.models import AgentSpec
from ..bundle import TaskBundle
from ..schema import SchemaValidationError, validate_result

logger = logging.getLogger(__name__)

# An executor runs the argv (with a kill timeout in seconds) and returns an
# ExecResult. Swappable so tests and dry-runs need not have abox installed.
Executor = Callable[..., "ExecResult"]

# Extra wall clock granted to the abox process beyond the sandbox --timeout:
# guest-image pull, the automatic host-side warm refresh (`abox run` re-runs
# the prepare flow in a separate warm sandbox when watch files changed), boot,
# and teardown all happen outside the guest deadline. A cold warm refresh can
# take minutes, hence well above the old 0.6.0 value of 120.
SUBPROCESS_TIMEOUT_HEADROOM_SECONDS = 600

# Extra guest deadline granted beyond the spec's timeoutSeconds: under abox
# 0.7.0 the in-guest environment setup (prepare.sh against warm caches) runs
# inside the sandbox --timeout, and the spec's budget is meant for agent work.
IN_GUEST_SETUP_HEADROOM_SECONDS = 300

# Timeout for the short bookkeeping calls (abox path / abox stop).
_HOUSEKEEPING_TIMEOUT_SECONDS = 120

# How many characters of console output to keep for diagnostics (ABOX-11).
_TAIL_CHARS = 20_000

# Spec networkMode -> abox 0.7.1 --network value (ABOX-6).
NETWORK_MODE_MAP = {"none": "safe", "scoped": "scoped", "open": "open"}

# Where the repo's prepare script appears inside the guest (the worktree is
# mounted at /workspace). Run when present: 0.7.0 sandboxes boot fresh OCI
# guests, so site-packages installed during `abox env warm` do not persist.
_GUEST_PREPARE_SCRIPT = "/workspace/.abox/prepare.sh"

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


# Registry-first repo lookup (repo onboarding, P2 Task 1), consulted by
# resolve_repo() before the legacy $BAKUDO_REPO_ROOT/<name> search. Module
# level because AboxRunner is constructed fresh per activity call (see
# Deps.sandbox_fn in temporal/_impl.py) with no surviving reference a caller
# could configure later -- set once at process start (Task 2 wires this to
# the ledger's get_repo).
_repo_resolver: Callable[[str], str | None] | None = None


def set_repo_resolver(fn: Callable[[str], str | None] | None) -> None:
    """Install (or, with ``None``, clear) the registry-first repo lookup.

    ``fn(name)`` returns the registered checkout path for a bare repo name,
    or ``None`` when the name has no registry entry (falls back to
    ``$BAKUDO_REPO_ROOT/<name>``, unchanged from the pre-registry behavior).
    """
    global _repo_resolver
    _repo_resolver = fn


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

    Note: these are *bakudo policy* profiles, never abox ``--template`` names
    (review finding ABOX-3). The guest OS profile (e.g. ``python-glibc``) is
    repo-owned ``.abox/project.toml`` config.

    **Advisory, not the enforcement point (SEC-4).** These fields document the
    intended per-role policy. The enforced controls live elsewhere: the microVM
    boundary and allowed commands/filesystem in abox's ``.abox/project.toml``;
    the outbound network via ``build_command``'s ``--network`` (from the
    AgentSpec's ``networkMode``, which *replaces* the project default per run —
    see the module docstring's network-mapping note);
    and ``maxChangedFiles`` when a candidate diff is scored (``evals/corpus.py``).
    Wiring every dimension here to a runtime check is future work — see
    ``docs/HUMAN_TASKS.md``. Do not read a value here as an active guarantee.
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


# Exit code recorded when a run is killed because its cancel_event was set
# (distinct from 124 = timed out). Mirrors a SIGTERM-style stop (SEC-5).
_CANCELLED_EXIT_CODE = 130

# How often the cancellable executor polls the process while waiting (seconds).
_CANCEL_POLL_SECONDS = 0.5


def _subprocess_executor(
    argv: list[str],
    timeout: float | None = None,
    cancel_event: object | None = None,
) -> ExecResult:
    """Run abox for real, mapping a host-side kill to exit 124 (ABOX-11).

    When ``cancel_event`` (a ``threading.Event``) is supplied, the process is
    run under a poll loop so a set event actually terminates it (SEC-5) —
    cancelling the Temporal activity alone cannot interrupt a blocking
    ``subprocess.run``, so a cancelled agent would otherwise keep running and
    spending until the sandbox timeout. Without an event the original
    fast-path ``subprocess.run`` is used unchanged.
    """
    if cancel_event is None:
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

    popen: subprocess.Popen[str] = subprocess.Popen(
        argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True
    )
    deadline = (time.monotonic() + timeout) if timeout else None
    while True:
        try:
            done_out, done_err = popen.communicate(timeout=_CANCEL_POLL_SECONDS)
            return ExecResult(popen.returncode, done_out or "", done_err or "")
        except subprocess.TimeoutExpired:
            if cancel_event.is_set():  # type: ignore[attr-defined]
                killed_out, killed_err = _terminate(popen)
                return ExecResult(_CANCELLED_EXIT_CODE, killed_out, killed_err)
            if deadline is not None and time.monotonic() >= deadline:
                killed_out, killed_err = _terminate(popen)
                return ExecResult(124, killed_out, killed_err, timed_out=True)


def _terminate(popen: subprocess.Popen[str]) -> tuple[str, str]:
    """SIGTERM then SIGKILL a process, returning whatever output it flushed."""
    popen.terminate()
    try:
        out, err = popen.communicate(timeout=5)
    except subprocess.TimeoutExpired:
        popen.kill()
        out, err = popen.communicate()
    return out or "", err or ""


class AboxRunner:
    """Builds and drives a single abox 0.7.1 sandbox run for a task bundle."""

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
        # Only the real subprocess executor is auto-verified before a run and
        # driven with a cancel_event: an injected executor (tests/dry-runs) is
        # trusted by construction and may not accept the extra argument (SEC-3/5).
        self._default_executor = executor is None
        self._verify_default_binary = executor is None
        self._binary_verified = False

    # -- binary identity (SEC-3) ------------------------------------------

    def verify_binary(self) -> str:
        """Assert ``abox_bin`` is really abox and return its version.

        The default executor is a plain host ``subprocess`` — the *only* thing
        making a run a microVM is that ``argv[0]`` resolves to abox. A missing
        binary already errors, but a *wrong* one would silently become a
        hostile-code host subprocess. This probes ``abox --version`` and fails
        closed unless the output identifies abox (the string ``abox`` or a
        version number); a missing binary raises :class:`AboxNotFoundError`.
        """
        try:
            res = self._executor(
                [self._abox_bin, "--version"], _HOUSEKEEPING_TIMEOUT_SECONDS
            )
        except FileNotFoundError as missing:
            raise AboxNotFoundError(
                f"abox binary not found: {self._abox_bin!r} is not on PATH "
                "(install abox 0.7.1 or set AboxRunner(abox_bin=...))."
            ) from missing
        out = f"{res.stdout} {res.stderr}".strip()
        if res.exit_code != 0:
            raise AboxError(
                f"`{self._abox_bin} --version` exited {res.exit_code} ({out!r}); "
                "refusing to run an unverified binary as the sandbox boundary."
            )
        # Require an abox-specific identifier (SEC-3): a bare version number is
        # not enough — `python3 --version` prints "Python 3.x" and would
        # otherwise pass, defeating the check for a wrong/substituted binary.
        if "abox" not in out.lower():
            raise AboxError(
                f"`{self._abox_bin} --version` output {out!r} does not identify "
                "abox; refusing to run an unverified binary as the sandbox "
                "boundary (set BAKUDO_ABOX_SKIP_VERSION_CHECK=1 to override)."
            )
        match = re.search(r"\d+\.\d+(?:\.\d+)?", out)
        return match.group(0) if match else out

    def _ensure_binary_verified(self) -> None:
        if self._binary_verified or not self._verify_default_binary:
            return
        if os.environ.get("BAKUDO_ABOX_SKIP_VERSION_CHECK") == "1":
            self._binary_verified = True
            return
        version = self.verify_binary()
        logger.info("verified abox binary %r: version %s", self._abox_bin, version)
        self._binary_verified = True

    # -- routing -----------------------------------------------------------

    def resolve_repo(self, bundle: TaskBundle) -> Path:
        """Resolve ``objective.repo`` to a host repo path (ABOX-7).

        Registry-first (repo onboarding, P2 Task 1): when a resolver is
        installed via :func:`set_repo_resolver` and returns a path for this
        name, that path is used. Otherwise (no resolver, or the name has no
        registry entry) resolution falls back to the original
        ``$BAKUDO_REPO_ROOT/<name>`` search, unchanged.

        An absolute-path objective bypasses BOTH the resolver and
        ``BAKUDO_REPO_ROOT`` -- existing behavior Temporal trials depend on:
        pathlib's ``root / abs_path`` already discards ``root``, so the
        registry lookup is skipped here to match rather than querying it
        with a path the fallback would ignore anyway.
        """
        name = bundle.objective.repo
        if _repo_resolver is not None and not Path(name).is_absolute():
            looked_up = _repo_resolver(name)
            if looked_up is not None:
                return Path(looked_up)
        root = self._repo_root
        if root is None:
            env_root = os.environ.get("BAKUDO_REPO_ROOT")
            root = Path(env_root) if env_root else Path.cwd()
        candidate = root / name
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

    @staticmethod
    def _base_ref(spec: AgentSpec) -> str:
        """The branch sandboxes fork from: ``BAKUDO_BASE_REF`` env override
        first (operator validating unmerged work), else the spec's baseRef."""
        return os.environ.get("BAKUDO_BASE_REF") or spec.sandbox.base_ref

    def build_command(
        self, bundle: TaskBundle, scratch_dir: Path, repo: Path | None = None
    ) -> list[str]:
        """Construct the abox 0.7.1 ``run`` argv (spec section 6.2)."""
        spec = bundle.agent_spec
        repo = repo or self.resolve_repo(bundle)
        network = NETWORK_MODE_MAP[spec.sandbox.network_mode.value]
        # Fail closed on `open`: the run-level --network *replaces* the repo's
        # trusted scoped allowlist (see the module docstring), so a
        # schema-valid — possibly model-authored — spec asking for `open`
        # would grant public-internet egress. No shipped role needs it; an
        # operator can opt in explicitly per worker.
        if network == "open" and os.environ.get("BAKUDO_ALLOW_NETWORK_OPEN") != "1":
            raise AboxError(
                "spec networkMode 'open' would replace the repo's scoped "
                "network allowlist with abox's public-internet egress mode; "
                "refusing without the operator opt-in BAKUDO_ALLOW_NETWORK_OPEN=1"
            )
        # The guest deadline covers in-guest environment setup plus agent work;
        # the spec's timeoutSeconds is the agent-work budget (see the headroom
        # constant). Enforcement still lands as abox exit code 124.
        guest_timeout = spec.sandbox.timeout_seconds + IN_GUEST_SETUP_HEADROOM_SECONDS

        argv = [
            self._abox_bin, "run",
            "--repo", str(repo),
            "--task", bundle.run_id,
            "--base", self._base_ref(spec),
            "--timeout", str(guest_timeout),
            "--network", network,
        ]
        # Never `--ephemeral`: abox would remove the worktree+branch the moment
        # the agent exits, before result.json can be collected via `abox path`.
        # Spec ephemerality is honoured by the unconditional post-collection
        # `abox stop --clean` in run()'s finally block instead.
        argv += ["--input-file", f"{scratch_dir / 'bundle.json'}:bundle.json"]
        for name in self._forwarded_env():
            argv += ["-e", f"{name}={os.environ[name]}"]
        # 0.7.0 run sandboxes boot fresh OCI guests (warm persists caches only,
        # not site-packages), so the repo's prepare flow must run in-guest
        # first — fast against the warm pip cache. Repos without a prepare
        # script skip straight to the runner (and fail at import, as before,
        # unless the guest image already carries the runner). `python3 -m` is
        # PATH-proof: it resolves through site-packages wherever pip installed
        # (system or user), while the `agent-runner` console script may land
        # off the guest PATH.
        guest_script = (
            "set -e; "
            f"[ ! -f {_GUEST_PREPARE_SCRIPT} ] || sh {_GUEST_PREPARE_SCRIPT}; "
            "exec python3 -m bakudo.runner.main "
            f"--bundle {self._guest_bundle_path} "
            "--result /workspace/.agent/result.json"
        )
        argv += ["--", "sh", "-c", guest_script]
        return argv

    # -- lifecycle ---------------------------------------------------------

    def run(
        self, bundle: TaskBundle, cancel_event: object | None = None
    ) -> AboxOutcome:
        started = time.monotonic()
        # Fail closed if the configured binary is not verifiably abox (SEC-3);
        # skipped for injected executors and when explicitly overridden.
        self._ensure_binary_verified()
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
            timeout = (
                spec.sandbox.timeout_seconds
                + IN_GUEST_SETUP_HEADROOM_SECONDS
                + SUBPROCESS_TIMEOUT_HEADROOM_SECONDS
            )
            try:
                # Only the default subprocess executor takes cancel_event; an
                # injected executor may not accept it (SEC-5). The unconditional
                # `abox stop --clean` in the finally still tears the microVM
                # down after a cancel-kill.
                if self._default_executor:
                    exec_result = self._executor(argv, timeout, cancel_event=cancel_event)
                else:
                    exec_result = self._executor(argv, timeout)
            except FileNotFoundError as missing:
                raise AboxNotFoundError(
                    f"abox binary not found: {self._abox_bin!r} is not on PATH "
                    "(install abox 0.7.1 or set AboxRunner(abox_bin=...))."
                ) from missing

            timed_out = exec_result.timed_out or exec_result.exit_code == 124
            errors: list[str] = []
            if timed_out:
                errors.append(
                    "sandbox timed out (abox --timeout "
                    f"{spec.sandbox.timeout_seconds + IN_GUEST_SETUP_HEADROOM_SECONDS}s"
                    f" = spec timeoutSeconds {spec.sandbox.timeout_seconds}s"
                    " + in-guest setup headroom)"
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
                    worktree, self._base_ref(spec)
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
