"""The task verify loop.

``verify_task`` is the acceptance gate for a task: it re-derives,
from the task's own fixture/verifier/reference content, every guarantee
the rest of the substrate assumes holds (experiment substrate design doc
section 5) -- that the failToPass tests actually fail on the pristine
fixture and pass once the reference solution is applied, that negative controls
are correctly rejected, that the reference solution hasn't leaked into the
instruction text a policy will observe, and that the task's bundle digest
still matches what was locked.

Checks run in a fixed order (``CHECK_ORDER``) so reports are stable and
diffable across runs.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

import yaml

from ..schema import validate_task_spec
from .provision import ProvisionedWorkspace, provision
from .source import LoadedTask
from .verifier_runner import VerificationResult, VerifierRunner

CHECK_ORDER = (
    "schema",
    "determinism",
    "fail_to_pass_pristine",
    "fail_to_pass_patched",
    "pass_to_pass",
    "negative_controls",
    "solution_leak",
    "spec_sufficiency",
    "immutability",
)

# The minimum length (after stripping) an added patch line must have before
# it's even considered as a candidate solution leak -- short additions like
# "}" or "return x" are too generic to be meaningful evidence of a leak.
_LEAK_MIN_LINE_LEN = 12
_LEAK_NGRAM_SIZE = 8


class _SetupError(Exception):
    """A verifier input, reference solution, or negative control a task's
    task.yaml names doesn't exist (or can't be read) on disk.

    This is a task-authoring bug, not a test outcome -- callers must
    catch it and turn it into a failing ``CheckResult`` naming the missing
    path, never let it propagate as a raw traceback.
    """


@dataclass
class CheckResult:
    name: str
    ok: bool
    advisory: bool
    detail: str


@dataclass
class VerifyReport:
    checks: list[CheckResult]
    ok: bool


def verify_task(
    task: LoadedTask,
    runner: VerifierRunner,
    llm_check: Callable[[str, str], str | None] | None = None,
) -> VerifyReport:
    """Run every verify-loop check against ``task`` and return a report.

    ``runner`` executes the task's verifier command through the
    :class:`~bakudo.tasks.verifier_runner.VerifierRunner` port;
    ``llm_check`` is an optional judge for the advisory ``spec_sufficiency``
    check -- when omitted that check is recorded as skipped, never failed.
    """
    checks: list[CheckResult] = []
    no_change = task.spec.metadata.family.value == "no-change"
    ref_patch = _reference_patch(task)

    with tempfile.TemporaryDirectory(prefix="bakudo-verify-") as tmp:
        scratch = Path(tmp)

        checks.append(_check_schema(task))
        checks.append(_check_determinism(task, scratch))
        checks.append(_check_fail_to_pass_pristine(task, scratch, runner, no_change))
        checks.append(_check_fail_to_pass_patched(task, scratch, runner, no_change, ref_patch))
        checks.append(_check_pass_to_pass(task, scratch, runner, no_change, ref_patch))
        checks.append(_check_negative_controls(task, scratch, runner))
        checks.append(_check_solution_leak(task, ref_patch))
        checks.append(_check_spec_sufficiency(task, llm_check))
        checks.append(_check_immutability(task))

    # Every check always contributes exactly one CheckResult (inapplicable
    # checks -- e.g. no-change families, or no llm_check -- report
    # ok=True/skipped rather than being omitted), so the emitted names must
    # match CHECK_ORDER exactly; this keeps CHECK_ORDER authoritative rather
    # than documentation nobody enforces.
    assert tuple(c.name for c in checks) == CHECK_ORDER, [c.name for c in checks]

    ok = all(c.ok for c in checks if not c.advisory)
    return VerifyReport(checks=checks, ok=ok)


# --------------------------------------------------------------------------
# Verifier-test execution helpers
# --------------------------------------------------------------------------


def _reference_patch(task: LoadedTask) -> Path | None:
    """The task's reference solution patch, if it has one.

    ``family == "no-change"`` tasks (and any task still missing a
    reference/ dir) may legitimately have none -- the checks that need it
    degrade gracefully rather than erroring.
    """
    candidate = task.path / "reference" / "solution.patch"
    return candidate if candidate.is_file() else None


def _ensure_conftest(repo_path: Path) -> None:
    """Make fixture modules importable from copied-in verifier tests.

    Pytest's default ("prepend") import mode inserts a test file's *basedir*
    -- the nearest ancestor directory without an ``__init__.py`` -- into
    ``sys.path``, not the invocation cwd. A verifier test copied to
    ``<workspace>/verifier/test_x.py`` therefore can't ``import summer`` (etc.)
    unless something anchors ``sys.path`` at the workspace root first. An
    (empty, if the fixture doesn't already ship one) ``conftest.py`` at the
    workspace root does exactly that, without touching ``verifier.testCommand``
    or fixture content.
    """
    conftest = repo_path / "conftest.py"
    if not conftest.exists():
        conftest.write_text("")


def _git_apply(repo_path: Path, patch_path: Path) -> None:
    subprocess.run(
        ["git", "apply", str(patch_path.resolve())],
        cwd=repo_path,
        check=True,
        capture_output=True,
        text=True,
    )


def _run_one_verifier_test(
    task: LoadedTask,
    dest: Path,
    rel_path: str,
    runner: VerifierRunner,
    patch: Path | None,
) -> VerificationResult:
    """Provision a fresh scratch workspace, optionally apply ``patch``, copy
    the single verifier test file at ``rel_path`` into ``verifier/``, and run it.

    Raises ``_SetupError`` (never a raw ``FileNotFoundError``/``OSError``)
    when ``rel_path`` or ``patch`` doesn't exist or can't be read -- that's a
    task-authoring bug (e.g. a stale ``verifier.failToPass`` entry, or a
    scaffolded task whose placeholder verifier test was never filled in),
    not a test outcome, and callers must surface it as a failing check
    rather than a run result.
    """
    src = task.path / rel_path
    if not src.is_file():
        raise _SetupError(f"verifier test file not found: {src}")
    if patch is not None and not patch.is_file():
        raise _SetupError(f"patch not found: {patch}")
    try:
        ws: ProvisionedWorkspace = provision(task, dest, seed=0)
        if patch is not None:
            _git_apply(ws.repo_path, patch)
        _ensure_conftest(ws.repo_path)
        verifier_dir = ws.repo_path / "verifier"
        verifier_dir.mkdir(exist_ok=True)
        name = Path(rel_path).name
        shutil.copy2(src, verifier_dir / name)
        command = task.spec.verifier.command.format(files=f"verifier/{name}")
        return runner(ws.repo_path, command)
    except subprocess.CalledProcessError as exc:
        detail = (exc.stdout or "") + (exc.stderr or "")
        return VerificationResult(passed=False, exit_code=exc.returncode, output=detail or str(exc))
    except subprocess.TimeoutExpired as exc:
        return VerificationResult(passed=False, exit_code=-1, output=str(exc))
    except OSError as exc:
        # Any other unreadable-file condition (permissions, races, ...) --
        # still a setup problem, not a test outcome.
        raise _SetupError(f"{rel_path}: {exc}") from exc


# --------------------------------------------------------------------------
# Individual checks
# --------------------------------------------------------------------------


def _check_schema(task: LoadedTask) -> CheckResult:
    name = "schema"
    try:
        data = yaml.safe_load((task.path / "task.yaml").read_text())
        validate_task_spec(data)
    except Exception as exc:  # noqa: BLE001 - surfaced as a check failure, not a crash
        return CheckResult(name, False, False, f"task.yaml failed schema validation: {exc}")
    return CheckResult(name, True, False, "task.yaml conforms to the schema")


def _check_determinism(task: LoadedTask, scratch: Path) -> CheckResult:
    name = "determinism"
    ws1 = provision(task, scratch / "determinism-a", seed=0)
    ws2 = provision(task, scratch / "determinism-b", seed=0)
    if ws1.base_ref != ws2.base_ref:
        return CheckResult(
            name,
            False,
            False,
            f"provisioning the same task twice produced different base_refs: "
            f"{ws1.base_ref} != {ws2.base_ref}",
        )
    return CheckResult(name, True, False, f"base_ref is reproducible ({ws1.base_ref})")


def _check_fail_to_pass_pristine(
    task: LoadedTask, scratch: Path, runner: VerifierRunner, no_change: bool
) -> CheckResult:
    name = "fail_to_pass_pristine"
    if no_change:
        return CheckResult(name, True, False, "no-change: skipped")
    fail_list = task.spec.verifier.fail_to_pass
    already_passing = []
    for i, rel in enumerate(fail_list):
        dest = scratch / f"ftp-pristine-{i}"
        try:
            result = _run_one_verifier_test(task, dest, rel, runner, patch=None)
        except _SetupError as exc:
            return CheckResult(name, False, False, str(exc))
        if result.passed:
            already_passing.append(rel)
    if already_passing:
        return CheckResult(
            name,
            False,
            False,
            f"failToPass test(s) already pass on the pristine fixture (bug not "
            f"planted): {already_passing}",
        )
    return CheckResult(
        name, True, False, f"{len(fail_list)} failToPass test(s) correctly fail pristine"
    )


def _check_fail_to_pass_patched(
    task: LoadedTask,
    scratch: Path,
    runner: VerifierRunner,
    no_change: bool,
    ref_patch: Path | None,
) -> CheckResult:
    name = "fail_to_pass_patched"
    if no_change:
        return CheckResult(name, True, False, "no-change: skipped")
    fail_list = task.spec.verifier.fail_to_pass
    if ref_patch is None:
        return CheckResult(name, False, False, "no reference/solution.patch to apply")
    still_failing = []
    for i, rel in enumerate(fail_list):
        dest = scratch / f"ftp-patched-{i}"
        try:
            result = _run_one_verifier_test(task, dest, rel, runner, patch=ref_patch)
        except _SetupError as exc:
            return CheckResult(name, False, False, str(exc))
        if not result.passed:
            still_failing.append(rel)
    if still_failing:
        return CheckResult(
            name,
            False,
            False,
            "failToPass test(s) still fail after applying "
            f"reference/solution.patch: {still_failing}",
        )
    return CheckResult(
        name,
        True,
        False,
        f"{len(fail_list)} failToPass test(s) pass after the reference patch",
    )


def _check_pass_to_pass(
    task: LoadedTask,
    scratch: Path,
    runner: VerifierRunner,
    no_change: bool,
    ref_patch: Path | None,
) -> CheckResult:
    name = "pass_to_pass"
    pass_list = task.spec.verifier.pass_to_pass
    if no_change:
        patch, state = None, "pristine"
    else:
        if ref_patch is None:
            return CheckResult(
                name, False, False, "no reference/solution.patch to verify passToPass against"
            )
        patch, state = ref_patch, "patched"
    failing = []
    for i, rel in enumerate(pass_list):
        dest = scratch / f"ptp-{i}"
        try:
            result = _run_one_verifier_test(task, dest, rel, runner, patch=patch)
        except _SetupError as exc:
            return CheckResult(name, False, False, str(exc))
        if not result.passed:
            failing.append(rel)
    if failing:
        return CheckResult(
            name, False, False, f"passToPass test(s) fail on the {state} fixture: {failing}"
        )
    return CheckResult(
        name, True, False, f"{len(pass_list)} passToPass test(s) pass on the {state} fixture"
    )


def _check_negative_controls(
    task: LoadedTask, scratch: Path, runner: VerifierRunner
) -> CheckResult:
    name = "negative_controls"
    probes = task.spec.verifier.negative_controls
    fail_list = task.spec.verifier.fail_to_pass
    if not probes:
        return CheckResult(name, True, False, "no negative controls defined")
    if not fail_list:
        return CheckResult(name, True, False, "no failToPass tests to probe against")
    wrongly_accepted = []
    for pi, probe_rel in enumerate(probes):
        probe_patch = task.path / probe_rel
        all_pass = True
        for ti, rel in enumerate(fail_list):
            dest = scratch / f"probe-{pi}-{ti}"
            try:
                result = _run_one_verifier_test(task, dest, rel, runner, patch=probe_patch)
            except _SetupError as exc:
                return CheckResult(name, False, False, str(exc))
            if not result.passed:
                all_pass = False
                break
        if all_pass:
            wrongly_accepted.append(probe_rel)
    if wrongly_accepted:
        return CheckResult(
            name,
            False,
            False,
            f"negative control(s) satisfy every failToPass test: {wrongly_accepted}",
        )
    return CheckResult(name, True, False, f"{len(probes)} negative control(s) rejected")


def _added_lines(patch_text: str) -> list[str]:
    lines = []
    for line in patch_text.splitlines():
        if line.startswith("+++"):
            continue
        if line.startswith("+"):
            content = line[1:].strip()
            if len(content) > _LEAK_MIN_LINE_LEN:
                lines.append(content)
    return lines


def _ngrams(tokens: list[str], n: int) -> set[tuple[str, ...]]:
    return {tuple(tokens[i : i + n]) for i in range(len(tokens) - n + 1)}


def _check_solution_leak(task: LoadedTask, ref_patch: Path | None) -> CheckResult:
    name = "solution_leak"
    if ref_patch is None:
        return CheckResult(name, True, False, "no reference/solution.patch to check")
    added = _added_lines(ref_patch.read_text())
    instruction_text = f"{task.spec.instruction.title}\n{task.spec.instruction.description}"

    verbatim = [line for line in added if line in instruction_text]
    if verbatim:
        return CheckResult(
            name,
            False,
            False,
            f"reference solution line(s) appear in the instruction: {verbatim}",
        )

    added_tokens = " ".join(added).split()
    instruction_tokens = instruction_text.split()
    overlap = _ngrams(added_tokens, _LEAK_NGRAM_SIZE) & _ngrams(
        instruction_tokens, _LEAK_NGRAM_SIZE
    )
    if overlap:
        sample = " ".join(next(iter(overlap)))
        return CheckResult(
            name,
            False,
            False,
            f"{_LEAK_NGRAM_SIZE}-gram token overlap between the reference patch and "
            f"instruction text: {sample!r}",
        )
    return CheckResult(name, True, False, "no reference-solution leakage in the instruction")


def _check_spec_sufficiency(
    task: LoadedTask, llm_check: Callable[[str, str], str | None] | None
) -> CheckResult:
    name = "spec_sufficiency"
    if llm_check is None:
        return CheckResult(name, True, True, "skipped: no llm_check provided")
    issue = llm_check(task.spec.instruction.title, task.spec.instruction.description)
    if issue:
        return CheckResult(name, False, True, issue)
    return CheckResult(name, True, True, "task instruction judged sufficient")


def _check_immutability(task: LoadedTask) -> CheckResult:
    name = "immutability"
    lockfile = task.path.parent / "digests.lock"
    if not lockfile.is_file():
        return CheckResult(name, True, False, "no digests.lock present")
    try:
        locked: dict[str, str] = json.loads(lockfile.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        return CheckResult(name, False, False, f"could not read digests.lock: {exc}")
    locked_digest = locked.get(task.ref)
    if locked_digest is None:
        return CheckResult(name, True, False, f"{task.ref} not yet locked")
    if locked_digest != task.pin.bundle_digest:
        return CheckResult(
            name,
            False,
            False,
            f"bundle digest changed ({locked_digest} -> {task.pin.bundle_digest}) "
            "without a version bump",
        )
    return CheckResult(name, True, False, "digest matches digests.lock")
