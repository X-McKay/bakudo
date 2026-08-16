"""The scenario verify loop.

``verify_scenario`` is the acceptance gate for a scenario: it re-derives,
from the scenario's own fixture/hidden/reference content, every guarantee
the rest of the substrate assumes holds (experiment substrate design doc
section 5) -- that the failToPass tests actually fail on the pristine
fixture and pass once the reference patch is applied, that wrong-fix probes
are correctly rejected, that the reference solution hasn't leaked into the
mission text an agent will read, and that the scenario's content digest
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

from ..schema import validate_scenario_spec
from .provision import ProvisionedWorkspace, provision
from .registry import LoadedScenario
from .testrun import TestRunner, TestRunResult

CHECK_ORDER = (
    "schema",
    "determinism",
    "fail_to_pass_pristine",
    "fail_to_pass_patched",
    "pass_to_pass",
    "wrong_fix_probes",
    "solution_leak",
    "spec_sufficiency",
    "immutability",
)

# The minimum length (after stripping) an added patch line must have before
# it's even considered as a candidate solution leak -- short additions like
# "}" or "return x" are too generic to be meaningful evidence of a leak.
_LEAK_MIN_LINE_LEN = 12
_LEAK_NGRAM_SIZE = 8


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


def verify_scenario(
    scenario: LoadedScenario,
    runner: TestRunner,
    llm_check: Callable[[str, str], str | None] | None = None,
) -> VerifyReport:
    """Run every verify-loop check against ``scenario`` and return a report.

    ``runner`` executes the scenario's hidden tests (see ``testrun.py``);
    ``llm_check`` is an optional judge for the advisory ``spec_sufficiency``
    check -- when omitted that check is recorded as skipped, never failed.
    """
    checks: list[CheckResult] = []
    no_change = scenario.spec.metadata.family.value == "no-change"
    ref_patch = _reference_patch(scenario)

    with tempfile.TemporaryDirectory(prefix="bakudo-verify-") as tmp:
        scratch = Path(tmp)

        checks.append(_check_schema(scenario))
        checks.append(_check_determinism(scenario, scratch))
        checks.append(_check_fail_to_pass_pristine(scenario, scratch, runner, no_change))
        checks.append(_check_fail_to_pass_patched(scenario, scratch, runner, no_change, ref_patch))
        checks.append(_check_pass_to_pass(scenario, scratch, runner, no_change, ref_patch))
        checks.append(_check_wrong_fix_probes(scenario, scratch, runner))
        checks.append(_check_solution_leak(scenario, ref_patch))
        checks.append(_check_spec_sufficiency(scenario, llm_check))
        checks.append(_check_immutability(scenario))

    ok = all(c.ok for c in checks if not c.advisory)
    return VerifyReport(checks=checks, ok=ok)


# --------------------------------------------------------------------------
# Hidden-test execution helpers
# --------------------------------------------------------------------------


def _reference_patch(scenario: LoadedScenario) -> Path | None:
    """The scenario's golden fix patch, if it has one.

    ``family == "no-change"`` scenarios (and any scenario still missing a
    reference/ dir) may legitimately have none -- the checks that need it
    degrade gracefully rather than erroring.
    """
    candidate = scenario.path / "reference" / "fix.patch"
    return candidate if candidate.is_file() else None


def _ensure_conftest(repo_path: Path) -> None:
    """Make fixture modules importable from copied-in hidden tests.

    Pytest's default ("prepend") import mode inserts a test file's *basedir*
    -- the nearest ancestor directory without an ``__init__.py`` -- into
    ``sys.path``, not the invocation cwd. A hidden test copied to
    ``<workspace>/hidden/test_x.py`` therefore can't ``import summer`` (etc.)
    unless something anchors ``sys.path`` at the workspace root first. An
    (empty, if the fixture doesn't already ship one) ``conftest.py`` at the
    workspace root does exactly that, without touching ``hidden.testCommand``
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


def _run_one_hidden_test(
    scenario: LoadedScenario,
    dest: Path,
    rel_path: str,
    runner: TestRunner,
    patch: Path | None,
) -> TestRunResult:
    """Provision a fresh scratch workspace, optionally apply ``patch``, copy
    the single hidden test file at ``rel_path`` into ``hidden/``, and run it.
    """
    try:
        ws: ProvisionedWorkspace = provision(scenario, dest, seed=0)
        if patch is not None:
            _git_apply(ws.repo_path, patch)
        _ensure_conftest(ws.repo_path)
        hidden_dir = ws.repo_path / "hidden"
        hidden_dir.mkdir(exist_ok=True)
        name = Path(rel_path).name
        shutil.copy2(scenario.path / rel_path, hidden_dir / name)
        command = scenario.spec.hidden.test_command.format(files=f"hidden/{name}")
        return runner(ws.repo_path, command)
    except subprocess.CalledProcessError as exc:
        detail = (exc.stdout or "") + (exc.stderr or "")
        return TestRunResult(passed=False, exit_code=exc.returncode, output=detail or str(exc))
    except subprocess.TimeoutExpired as exc:
        return TestRunResult(passed=False, exit_code=-1, output=str(exc))


# --------------------------------------------------------------------------
# Individual checks
# --------------------------------------------------------------------------


def _check_schema(scenario: LoadedScenario) -> CheckResult:
    name = "schema"
    try:
        data = yaml.safe_load((scenario.path / "scenario.yaml").read_text())
        validate_scenario_spec(data)
    except Exception as exc:  # noqa: BLE001 - surfaced as a check failure, not a crash
        return CheckResult(name, False, False, f"scenario.yaml failed schema validation: {exc}")
    return CheckResult(name, True, False, "scenario.yaml conforms to the schema")


def _check_determinism(scenario: LoadedScenario, scratch: Path) -> CheckResult:
    name = "determinism"
    ws1 = provision(scenario, scratch / "determinism-a", seed=0)
    ws2 = provision(scenario, scratch / "determinism-b", seed=0)
    if ws1.base_ref != ws2.base_ref:
        return CheckResult(
            name, False, False,
            f"provisioning the same scenario twice produced different base_refs: "
            f"{ws1.base_ref} != {ws2.base_ref}",
        )
    return CheckResult(name, True, False, f"base_ref is reproducible ({ws1.base_ref})")


def _check_fail_to_pass_pristine(
    scenario: LoadedScenario, scratch: Path, runner: TestRunner, no_change: bool
) -> CheckResult:
    name = "fail_to_pass_pristine"
    if no_change:
        return CheckResult(name, True, False, "no-change: skipped")
    fail_list = scenario.spec.hidden.fail_to_pass
    already_passing = []
    for i, rel in enumerate(fail_list):
        dest = scratch / f"ftp-pristine-{i}"
        result = _run_one_hidden_test(scenario, dest, rel, runner, patch=None)
        if result.passed:
            already_passing.append(rel)
    if already_passing:
        return CheckResult(
            name, False, False,
            f"failToPass test(s) already pass on the pristine fixture (bug not "
            f"planted): {already_passing}",
        )
    return CheckResult(
        name, True, False, f"{len(fail_list)} failToPass test(s) correctly fail pristine"
    )


def _check_fail_to_pass_patched(
    scenario: LoadedScenario,
    scratch: Path,
    runner: TestRunner,
    no_change: bool,
    ref_patch: Path | None,
) -> CheckResult:
    name = "fail_to_pass_patched"
    if no_change:
        return CheckResult(name, True, False, "no-change: skipped")
    fail_list = scenario.spec.hidden.fail_to_pass
    if ref_patch is None:
        return CheckResult(name, False, False, "no reference/fix.patch to apply")
    still_failing = []
    for i, rel in enumerate(fail_list):
        dest = scratch / f"ftp-patched-{i}"
        result = _run_one_hidden_test(scenario, dest, rel, runner, patch=ref_patch)
        if not result.passed:
            still_failing.append(rel)
    if still_failing:
        return CheckResult(
            name, False, False,
            f"failToPass test(s) still fail after applying reference/fix.patch: {still_failing}",
        )
    return CheckResult(
        name, True, False,
        f"{len(fail_list)} failToPass test(s) pass after the reference patch",
    )


def _check_pass_to_pass(
    scenario: LoadedScenario,
    scratch: Path,
    runner: TestRunner,
    no_change: bool,
    ref_patch: Path | None,
) -> CheckResult:
    name = "pass_to_pass"
    pass_list = scenario.spec.hidden.pass_to_pass
    if no_change:
        patch, state = None, "pristine"
    else:
        if ref_patch is None:
            return CheckResult(
                name, False, False, "no reference/fix.patch to verify passToPass against"
            )
        patch, state = ref_patch, "patched"
    failing = []
    for i, rel in enumerate(pass_list):
        result = _run_one_hidden_test(scenario, scratch / f"ptp-{i}", rel, runner, patch=patch)
        if not result.passed:
            failing.append(rel)
    if failing:
        return CheckResult(
            name, False, False, f"passToPass test(s) fail on the {state} fixture: {failing}"
        )
    return CheckResult(
        name, True, False, f"{len(pass_list)} passToPass test(s) pass on the {state} fixture"
    )


def _check_wrong_fix_probes(
    scenario: LoadedScenario, scratch: Path, runner: TestRunner
) -> CheckResult:
    name = "wrong_fix_probes"
    probes = scenario.spec.hidden.wrong_fix_probes
    fail_list = scenario.spec.hidden.fail_to_pass
    if not probes:
        return CheckResult(name, True, False, "no wrong-fix probes defined")
    if not fail_list:
        return CheckResult(name, True, False, "no failToPass tests to probe against")
    wrongly_accepted = []
    for pi, probe_rel in enumerate(probes):
        probe_patch = scenario.path / probe_rel
        all_pass = True
        for ti, rel in enumerate(fail_list):
            dest = scratch / f"probe-{pi}-{ti}"
            result = _run_one_hidden_test(scenario, dest, rel, runner, patch=probe_patch)
            if not result.passed:
                all_pass = False
                break
        if all_pass:
            wrongly_accepted.append(probe_rel)
    if wrongly_accepted:
        return CheckResult(
            name, False, False,
            f"wrong-fix probe(s) incorrectly satisfy every failToPass test: {wrongly_accepted}",
        )
    return CheckResult(name, True, False, f"{len(probes)} wrong-fix probe(s) correctly rejected")


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


def _check_solution_leak(scenario: LoadedScenario, ref_patch: Path | None) -> CheckResult:
    name = "solution_leak"
    if ref_patch is None:
        return CheckResult(name, True, False, "no reference/fix.patch to check for leakage")
    added = _added_lines(ref_patch.read_text())
    mission_text = f"{scenario.spec.mission.title}\n{scenario.spec.mission.description}"

    verbatim = [line for line in added if line in mission_text]
    if verbatim:
        return CheckResult(
            name, False, False,
            f"reference patch line(s) appear verbatim in the mission text: {verbatim}",
        )

    added_tokens = " ".join(added).split()
    mission_tokens = mission_text.split()
    overlap = _ngrams(added_tokens, _LEAK_NGRAM_SIZE) & _ngrams(mission_tokens, _LEAK_NGRAM_SIZE)
    if overlap:
        sample = " ".join(next(iter(overlap)))
        return CheckResult(
            name, False, False,
            f"{_LEAK_NGRAM_SIZE}-gram token overlap between the reference patch and "
            f"mission text: {sample!r}",
        )
    return CheckResult(name, True, False, "no reference-patch leakage detected in the mission text")


def _check_spec_sufficiency(
    scenario: LoadedScenario, llm_check: Callable[[str, str], str | None] | None
) -> CheckResult:
    name = "spec_sufficiency"
    if llm_check is None:
        return CheckResult(name, True, True, "skipped: no llm_check provided")
    issue = llm_check(scenario.spec.mission.title, scenario.spec.mission.description)
    if issue:
        return CheckResult(name, False, True, issue)
    return CheckResult(name, True, True, "mission spec judged sufficient")


def _check_immutability(scenario: LoadedScenario) -> CheckResult:
    name = "immutability"
    lockfile = scenario.path.parent / "digests.lock"
    if not lockfile.is_file():
        return CheckResult(name, True, False, "no digests.lock present")
    try:
        locked: dict[str, str] = json.loads(lockfile.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        return CheckResult(name, False, False, f"could not read digests.lock: {exc}")
    locked_digest = locked.get(scenario.ref)
    if locked_digest is None:
        return CheckResult(name, True, False, f"{scenario.ref} not yet locked")
    if locked_digest != scenario.digest:
        return CheckResult(
            name, False, False,
            f"digest changed ({locked_digest} -> {scenario.digest}) without a version bump",
        )
    return CheckResult(name, True, False, "digest matches digests.lock")
