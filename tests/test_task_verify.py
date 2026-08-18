import json
from pathlib import Path

import pytest
import yaml

from bakudo.cli import main
from bakudo.paths import smoke_tasks_dir
from bakudo.tasks.source import DirectoryTaskSource, TaskLoadError
from bakudo.tasks.verifier_runner import local_verifier_runner
from bakudo.tasks.verify import CHECK_ORDER, verify_task

# A tiny, self-contained "add" bug used by the synthetic tasks below.
# Both patches are real `git diff` output (verified to `git apply` cleanly
# against the buggy fixture) rather than hand-typed unified diffs, so their
# hunk headers/context lines are exactly what git itself would produce.
_BUGGY_APP = "def add(a, b):\n    return a - b  # BUG: should add, not subtract\n"
_FIXED_APP = "def add(a, b):\n    return a + b  # fixed: now correctly adds the operands\n"

_FIX_PATCH = """\
diff --git a/app.py b/app.py
index 5349683..8f71830 100644
--- a/app.py
+++ b/app.py
@@ -1,2 +1,2 @@
 def add(a, b):
-    return a - b  # BUG: should add, not subtract
+    return a + b  # fixed: now correctly adds the operands
"""

# A "wrong fix" that happens to also pass the (weak) verifier test below,
# because addition is commutative -- used to prove negative_controls catches
# a negative control that was supposed to fail but doesn't.
_WRONG_PATCH = """\
diff --git a/app.py b/app.py
index 5349683..b099b77 100644
--- a/app.py
+++ b/app.py
@@ -1,2 +1,2 @@
 def add(a, b):
-    return a - b  # BUG: should add, not subtract
+    return b + a  # naive swap, still commutative -- looks plausible but is not the real fix
"""

MINIMAL = {
    "apiVersion": "bakudo.ai/v1alpha1",
    "kind": "TaskSpec",
    "metadata": {
        "name": "add-bug",
        "version": 1,
        "family": "debugging",
        "difficulty": "easy",
        "tags": ["python"],
        "partition": "dev",
        "canary": "bakudo-canary-TESTGUID",
        "provenance": {
            "createdBy": "human",
            "createdAt": "2026-08-15",
            "sourceType": "hand-written",
            "eligibleForPromotion": True,
        },
    },
    "instruction": {
        "type": "qa",
        "title": "Fix add()",
        "description": "add() returns the wrong value.",
        "successCriteria": ["add(2, 3) == 5"],
    },
    "environment": {"profile": "python-glibc", "network": "none"},
    "limits": {"wallSeconds": 600, "toolCalls": 30, "tokens": 20000},
    "verifier": {
        "failToPass": ["verifier/test_add.py"],
        "passToPass": ["verifier/test_smoke.py"],
        "command": "pytest {files} -q",
        "negativeControls": [],
    },
    "constraints": {
        "expectedStatus": "success",
        "allowedChangePaths": ["app.py"],
        "maxChangedFiles": 1,
        "forbidsDeniedActions": True,
        "verifierInputsImmutable": True,
    },
}


def make_bug_task(
    parent,
    name="add-bug",
    bug_planted=True,
    instruction_description=None,
    with_negative_control=False,
    with_reference_patch=True,
):
    """Write a task dir under parent/name exercising a tiny `add()` bug.

    ``bug_planted=False`` makes the failToPass test pass even on the
    pristine fixture (nothing to fix).
    """
    import copy

    spec = copy.deepcopy(MINIMAL)
    spec["metadata"]["name"] = name
    if instruction_description is not None:
        spec["instruction"]["description"] = instruction_description
    if with_negative_control:
        spec["verifier"]["negativeControls"] = ["reference/negative-control-wrong.patch"]

    d = parent / name
    d.mkdir(parents=True, exist_ok=True)
    (d / "task.yaml").write_text(yaml.safe_dump(spec, sort_keys=False))

    fixture = d / "fixture"
    fixture.mkdir()
    (fixture / "app.py").write_text(_FIXED_APP if not bug_planted else _BUGGY_APP)

    verifier = d / "verifier"
    verifier.mkdir()
    (verifier / "test_add.py").write_text(
        "from app import add\n\n\ndef test_add():\n    assert add(2, 3) == 5\n"
    )
    (verifier / "test_smoke.py").write_text("def test_true():\n    assert True\n")

    if with_reference_patch or with_negative_control:
        reference = d / "reference"
        reference.mkdir()
        if with_reference_patch:
            (reference / "solution.patch").write_text(_FIX_PATCH)
        if with_negative_control:
            (reference / "negative-control-wrong.patch").write_text(_WRONG_PATCH)

    return d


def load_loaded_task(tmp_path, **kwargs):
    root = tmp_path / "tasks"
    root.mkdir(exist_ok=True)
    name = kwargs.get("name", "add-bug")
    make_bug_task(root, **kwargs)
    source = DirectoryTaskSource(root)
    return source.get(f"{name}@1")


def test_exemplars_all_verify(monkeypatch):
    monkeypatch.setenv("BAKUDO_ENV", "dev")
    reg = DirectoryTaskSource(smoke_tasks_dir())
    for task in reg.list():
        report = verify_task(task, local_verifier_runner)
        assert report.ok, [c for c in report.checks if not c.ok]


def test_runner_guard(monkeypatch):
    monkeypatch.delenv("BAKUDO_ENV", raising=False)
    with pytest.raises(RuntimeError):
        local_verifier_runner(Path("."), "true")


def test_check_order_is_stable(tmp_path, monkeypatch):
    monkeypatch.setenv("BAKUDO_ENV", "dev")
    task = load_loaded_task(tmp_path)
    report = verify_task(task, local_verifier_runner)
    # CHECK_ORDER is the single source of truth for both the doc comment and
    # the runtime assertion in verify_task -- exercise it here too so it
    # can't silently drift out of sync with what actually gets emitted.
    assert [c.name for c in report.checks] == list(CHECK_ORDER)


def test_well_formed_task_verifies_clean(tmp_path, monkeypatch):
    monkeypatch.setenv("BAKUDO_ENV", "dev")
    task = load_loaded_task(tmp_path)
    report = verify_task(task, local_verifier_runner)
    assert report.ok, [c for c in report.checks if not c.ok]


def test_bug_not_planted_fails(tmp_path, monkeypatch):
    monkeypatch.setenv("BAKUDO_ENV", "dev")
    task = load_loaded_task(tmp_path, bug_planted=False)
    report = verify_task(task, local_verifier_runner)
    ftp = next(c for c in report.checks if c.name == "fail_to_pass_pristine")
    assert not ftp.ok
    assert not report.ok


def test_solution_leak_detected(tmp_path, monkeypatch):
    monkeypatch.setenv("BAKUDO_ENV", "dev")
    leaking_description = (
        "The fix is: return a + b  # fixed: now correctly adds the operands -- just copy that in."
    )
    task = load_loaded_task(tmp_path, instruction_description=leaking_description)
    report = verify_task(task, local_verifier_runner)
    leak = next(c for c in report.checks if c.name == "solution_leak")
    assert not leak.ok
    assert not report.ok


def test_negative_control_must_be_rejected(tmp_path, monkeypatch):
    monkeypatch.setenv("BAKUDO_ENV", "dev")
    task = load_loaded_task(tmp_path, with_negative_control=True)
    report = verify_task(task, local_verifier_runner)
    probes = next(c for c in report.checks if c.name == "negative_controls")
    assert not probes.ok
    assert not report.ok


def test_no_change_family_skips_fail_to_pass(tmp_path, monkeypatch):
    monkeypatch.setenv("BAKUDO_ENV", "dev")
    root = tmp_path / "tasks"
    root.mkdir()
    import copy

    spec = copy.deepcopy(MINIMAL)
    spec["metadata"]["name"] = "add-nochange"
    spec["metadata"]["family"] = "no-change"
    spec["verifier"]["failToPass"] = []
    spec["verifier"]["passToPass"] = ["verifier/test_smoke.py"]
    spec["constraints"]["allowedChangePaths"] = []
    spec["constraints"]["maxChangedFiles"] = 0

    d = root / "add-nochange"
    d.mkdir()
    (d / "task.yaml").write_text(yaml.safe_dump(spec, sort_keys=False))
    fixture = d / "fixture"
    fixture.mkdir()
    (fixture / "app.py").write_text(_FIXED_APP)
    verifier = d / "verifier"
    verifier.mkdir()
    (verifier / "test_smoke.py").write_text("def test_true():\n    assert True\n")

    source = DirectoryTaskSource(root)
    task = source.get("add-nochange@1")
    report = verify_task(task, local_verifier_runner)

    ftp_pristine = next(c for c in report.checks if c.name == "fail_to_pass_pristine")
    ftp_patched = next(c for c in report.checks if c.name == "fail_to_pass_patched")
    ptp = next(c for c in report.checks if c.name == "pass_to_pass")
    assert ftp_pristine.ok and "no-change" in ftp_pristine.detail
    assert ftp_patched.ok and "no-change" in ftp_patched.detail
    assert ptp.ok
    assert report.ok


def test_spec_sufficiency_skipped_without_llm_check(tmp_path, monkeypatch):
    monkeypatch.setenv("BAKUDO_ENV", "dev")
    task = load_loaded_task(tmp_path)
    report = verify_task(task, local_verifier_runner)
    spec_check = next(c for c in report.checks if c.name == "spec_sufficiency")
    assert spec_check.ok
    assert spec_check.advisory
    assert "skipped" in spec_check.detail


def test_spec_sufficiency_advisory_failure_does_not_fail_report(tmp_path, monkeypatch):
    monkeypatch.setenv("BAKUDO_ENV", "dev")
    task = load_loaded_task(tmp_path)

    def review(title, description):
        return "instruction is ambiguous about the acceptance bar"

    report = verify_task(task, local_verifier_runner, llm_check=review)
    spec_check = next(c for c in report.checks if c.name == "spec_sufficiency")
    assert not spec_check.ok
    assert spec_check.advisory
    assert report.ok  # advisory failures don't sink the overall report


def test_immutability_flags_drift(tmp_path, monkeypatch):
    monkeypatch.setenv("BAKUDO_ENV", "dev")
    root = tmp_path / "tasks"
    root.mkdir()
    make_bug_task(root)
    source = DirectoryTaskSource(root)
    task = source.get("add-bug@1")
    lockfile = root / "digests.lock"
    lockfile.write_text(json.dumps({task.ref: "sha256:" + "0" * 64}))

    source = DirectoryTaskSource(root)
    task = source.get("add-bug@1")
    report = verify_task(task, local_verifier_runner)
    immut = next(c for c in report.checks if c.name == "immutability")
    assert not immut.ok
    assert not report.ok


def test_cli_task_list_json(monkeypatch, capsys):
    rc = main(["task", "list", "--json"])
    out = json.loads(capsys.readouterr().out)
    assert rc == 0
    assert {entry["ref"] for entry in out} == {
        "smoke-rate-limiter-fix@1",
        "smoke-rate-limiter-nochange@1",
    }


def test_cli_task_list_filters_by_family(monkeypatch, capsys):
    rc = main(["task", "list", "--family", "no-change", "--json"])
    out = json.loads(capsys.readouterr().out)
    assert rc == 0
    assert [e["ref"] for e in out] == ["smoke-rate-limiter-nochange@1"]


def test_cli_verify_json(monkeypatch, capsys):
    monkeypatch.setenv("BAKUDO_ENV", "dev")
    rc = main(["task", "verify", "smoke-rate-limiter-fix", "--json"])
    out = json.loads(capsys.readouterr().out)
    assert rc == 0
    assert out["ok"] is True
    assert [c["name"] for c in out["checks"]] == list(CHECK_ORDER)


def test_cli_verify_uses_the_shared_verifier_resolution(monkeypatch, capsys):
    import bakudo.cli as cli

    called = []

    def resolve(command):
        called.append(command)
        return local_verifier_runner, None

    monkeypatch.setenv("BAKUDO_ENV", "dev")
    monkeypatch.setattr(cli, "_resolve_verifier_runner", resolve)

    assert main(["task", "verify", "smoke-rate-limiter-fix", "--json"]) == 0
    capsys.readouterr()
    assert called == ["task verify"]


def test_cli_verify_exits_nonzero_without_dev_env(monkeypatch, capsys):
    monkeypatch.delenv("BAKUDO_ENV", raising=False)
    rc = main(["task", "verify", "smoke-rate-limiter-fix"])
    err = capsys.readouterr().err
    assert rc == 2
    assert "BAKUDO_ENV" in err


def test_cli_task_scaffold_writes_template_and_refuses_overwrite(tmp_path):
    rc = main(["task", "scaffold", "new-task", "--family", "debugging", "--root", str(tmp_path)])
    assert rc == 0
    d = tmp_path / "new-task"
    assert (d / "task.yaml").is_file()
    assert (d / "fixture" / "README.md").is_file()
    assert (d / "verifier" / "README.md").is_file()
    assert (d / "reference" / "README.md").is_file()
    text = (d / "task.yaml").read_text()
    assert "canary GUID" in text
    assert "family: debugging" in text

    rc = main(["task", "scaffold", "new-task", "--family", "debugging", "--root", str(tmp_path)])
    assert rc == 1


def test_task_source_rejects_missing_verifier_input(tmp_path):
    """verifier.failToPass naming a file that isn't actually on disk (a stale
    entry, or -- as review found -- exactly what `bakudo task scaffold`
    leaves behind before its verifier/test_TODO.py placeholder is filled in)
    is rejected while loading the source, before it can enter a trial."""
    root = tmp_path / "tasks"
    root.mkdir()
    make_bug_task(root)

    task_yaml = root / "add-bug" / "task.yaml"
    spec = yaml.safe_load(task_yaml.read_text())
    spec["verifier"]["failToPass"] = ["verifier/does-not-exist.py"]
    task_yaml.write_text(yaml.safe_dump(spec, sort_keys=False))

    with pytest.raises(TaskLoadError, match="does-not-exist.py"):
        DirectoryTaskSource(root)


def test_cli_scaffold_then_verify_fails_cleanly_with_exit_code_1(tmp_path, monkeypatch, capsys):
    """End-to-end repro from review: `scaffold` then `verify` on the
    untouched placeholder must yield a clean source-validation error (rc=1)
    through main(), not a traceback."""
    monkeypatch.setenv("BAKUDO_ENV", "dev")
    monkeypatch.setenv("BAKUDO_TASK_SOURCE", str(tmp_path))

    rc = main(["task", "scaffold", "demo", "--family", "debugging", "--root", str(tmp_path)])
    assert rc == 0
    capsys.readouterr()  # discard scaffold's own stdout

    rc = main(["task", "verify", "demo", "--json"])
    captured = capsys.readouterr()
    assert rc == 1
    assert captured.out == ""
    assert "verifier/test_TODO.py" in captured.err
