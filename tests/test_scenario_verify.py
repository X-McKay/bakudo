import json
from pathlib import Path

import pytest
import yaml

from bakudo.cli import main
from bakudo.paths import scenarios_dir
from bakudo.scenarios.registry import ScenarioRegistry
from bakudo.scenarios.testrun import local_test_runner
from bakudo.scenarios.verify import CHECK_ORDER, verify_scenario

# A tiny, self-contained "add" bug used by the synthetic scenarios below.
# Both patches are real `git diff` output (verified to `git apply` cleanly
# against the buggy fixture) rather than hand-typed unified diffs, so their
# hunk headers/context lines are exactly what git itself would produce.
_BUGGY_APP = 'def add(a, b):\n    return a - b  # BUG: should add, not subtract\n'
_FIXED_APP = 'def add(a, b):\n    return a + b  # fixed: now correctly adds the operands\n'

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

# A "wrong fix" that happens to also pass the (weak) hidden test below,
# because addition is commutative -- used to prove wrong_fix_probes catches
# a probe that was supposed to fail but doesn't.
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
    "kind": "ScenarioSpec",
    "metadata": {
        "name": "add-bug", "version": 1, "family": "debugging",
        "difficulty": "easy", "tags": ["python"], "partition": "dev",
        "canary": "bakudo-canary-TESTGUID",
        "provenance": {"createdBy": "human", "createdAt": "2026-08-15",
                       "sourceType": "hand-written", "eligibleForPromotion": True},
    },
    "mission": {"type": "qa", "title": "Fix add()", "description": "add() returns the wrong value.",
                "acceptanceCriteria": ["add(2, 3) == 5"], "constraints": {"maxFilesChanged": 1}},
    "environment": {"profile": "python-glibc", "network": "none"},
    "budgets": {"wallSeconds": 600, "toolCalls": 30, "tokens": 20000},
    "hidden": {"failToPass": ["hidden/test_add.py"], "passToPass": ["hidden/test_smoke.py"],
               "testCommand": "pytest {files} -q", "wrongFixProbes": [],
               "expectedFiles": ["app.py"]},
    "expect": {"status": "success", "changesPaths": ["app.py"], "maxChangedFiles": 1,
               "forbidsDeniedCommands": True, "testPathsImmutable": True},
}


def make_bug_scenario(
    parent,
    name="add-bug",
    bug_planted=True,
    mission_description=None,
    with_wrong_fix_probe=False,
    with_reference_patch=True,
):
    """Write a scenario dir under parent/name exercising a tiny `add()` bug.

    ``bug_planted=False`` makes the failToPass test pass even on the
    pristine fixture (nothing to fix).
    """
    import copy

    spec = copy.deepcopy(MINIMAL)
    spec["metadata"]["name"] = name
    if mission_description is not None:
        spec["mission"]["description"] = mission_description
    if with_wrong_fix_probe:
        spec["hidden"]["wrongFixProbes"] = ["reference/wrong.patch"]

    d = parent / name
    d.mkdir(parents=True, exist_ok=True)
    (d / "scenario.yaml").write_text(yaml.safe_dump(spec, sort_keys=False))

    fixture = d / "fixture"
    fixture.mkdir()
    (fixture / "app.py").write_text(_FIXED_APP if not bug_planted else _BUGGY_APP)

    hidden = d / "hidden"
    hidden.mkdir()
    (hidden / "test_add.py").write_text(
        "from app import add\n\n\ndef test_add():\n    assert add(2, 3) == 5\n"
    )
    (hidden / "test_smoke.py").write_text("def test_true():\n    assert True\n")

    if with_reference_patch or with_wrong_fix_probe:
        reference = d / "reference"
        reference.mkdir()
        if with_reference_patch:
            (reference / "fix.patch").write_text(_FIX_PATCH)
        if with_wrong_fix_probe:
            (reference / "wrong.patch").write_text(_WRONG_PATCH)

    return d


def load_loaded_scenario(tmp_path, **kwargs):
    root = tmp_path / "scenarios"
    root.mkdir(exist_ok=True)
    name = kwargs.get("name", "add-bug")
    make_bug_scenario(root, **kwargs)
    registry = ScenarioRegistry(root)
    return registry.get(f"{name}@1")


def test_exemplars_all_verify(monkeypatch):
    monkeypatch.setenv("BAKUDO_ENV", "dev")
    reg = ScenarioRegistry(scenarios_dir())
    for s in reg.list():
        report = verify_scenario(s, local_test_runner)
        assert report.ok, [c for c in report.checks if not c.ok]


def test_runner_guard(monkeypatch):
    monkeypatch.delenv("BAKUDO_ENV", raising=False)
    with pytest.raises(RuntimeError):
        local_test_runner(Path("."), "true")


def test_check_order_is_stable(tmp_path, monkeypatch):
    monkeypatch.setenv("BAKUDO_ENV", "dev")
    scn = load_loaded_scenario(tmp_path)
    report = verify_scenario(scn, local_test_runner)
    # CHECK_ORDER is the single source of truth for both the doc comment and
    # the runtime assertion in verify_scenario -- exercise it here too so it
    # can't silently drift out of sync with what actually gets emitted.
    assert [c.name for c in report.checks] == list(CHECK_ORDER)


def test_well_formed_scenario_verifies_clean(tmp_path, monkeypatch):
    monkeypatch.setenv("BAKUDO_ENV", "dev")
    scn = load_loaded_scenario(tmp_path)
    report = verify_scenario(scn, local_test_runner)
    assert report.ok, [c for c in report.checks if not c.ok]


def test_bug_not_planted_fails(tmp_path, monkeypatch):
    monkeypatch.setenv("BAKUDO_ENV", "dev")
    scn = load_loaded_scenario(tmp_path, bug_planted=False)
    report = verify_scenario(scn, local_test_runner)
    ftp = next(c for c in report.checks if c.name == "fail_to_pass_pristine")
    assert not ftp.ok
    assert not report.ok


def test_solution_leak_detected(tmp_path, monkeypatch):
    monkeypatch.setenv("BAKUDO_ENV", "dev")
    leaking_description = (
        "The fix is: return a + b  # fixed: now correctly adds the operands -- just copy that in."
    )
    scn = load_loaded_scenario(tmp_path, mission_description=leaking_description)
    report = verify_scenario(scn, local_test_runner)
    leak = next(c for c in report.checks if c.name == "solution_leak")
    assert not leak.ok
    assert not report.ok


def test_wrong_fix_probe_must_be_rejected(tmp_path, monkeypatch):
    monkeypatch.setenv("BAKUDO_ENV", "dev")
    scn = load_loaded_scenario(tmp_path, with_wrong_fix_probe=True)
    report = verify_scenario(scn, local_test_runner)
    probes = next(c for c in report.checks if c.name == "wrong_fix_probes")
    assert not probes.ok
    assert not report.ok


def test_no_change_family_skips_fail_to_pass(tmp_path, monkeypatch):
    monkeypatch.setenv("BAKUDO_ENV", "dev")
    root = tmp_path / "scenarios"
    root.mkdir()
    import copy

    spec = copy.deepcopy(MINIMAL)
    spec["metadata"]["name"] = "add-nochange"
    spec["metadata"]["family"] = "no-change"
    spec["mission"]["constraints"]["maxFilesChanged"] = 0
    spec["hidden"]["failToPass"] = []
    spec["hidden"]["passToPass"] = ["hidden/test_smoke.py"]
    spec["expect"]["changesPaths"] = []
    spec["expect"]["maxChangedFiles"] = 0

    d = root / "add-nochange"
    d.mkdir()
    (d / "scenario.yaml").write_text(yaml.safe_dump(spec, sort_keys=False))
    fixture = d / "fixture"
    fixture.mkdir()
    (fixture / "app.py").write_text(_FIXED_APP)
    hidden = d / "hidden"
    hidden.mkdir()
    (hidden / "test_smoke.py").write_text("def test_true():\n    assert True\n")

    registry = ScenarioRegistry(root)
    scn = registry.get("add-nochange@1")
    report = verify_scenario(scn, local_test_runner)

    ftp_pristine = next(c for c in report.checks if c.name == "fail_to_pass_pristine")
    ftp_patched = next(c for c in report.checks if c.name == "fail_to_pass_patched")
    ptp = next(c for c in report.checks if c.name == "pass_to_pass")
    assert ftp_pristine.ok and "no-change" in ftp_pristine.detail
    assert ftp_patched.ok and "no-change" in ftp_patched.detail
    assert ptp.ok
    assert report.ok


def test_spec_sufficiency_skipped_without_llm_check(tmp_path, monkeypatch):
    monkeypatch.setenv("BAKUDO_ENV", "dev")
    scn = load_loaded_scenario(tmp_path)
    report = verify_scenario(scn, local_test_runner)
    spec_check = next(c for c in report.checks if c.name == "spec_sufficiency")
    assert spec_check.ok
    assert spec_check.advisory
    assert "skipped" in spec_check.detail


def test_spec_sufficiency_advisory_failure_does_not_fail_report(tmp_path, monkeypatch):
    monkeypatch.setenv("BAKUDO_ENV", "dev")
    scn = load_loaded_scenario(tmp_path)

    def judge(title, description):
        return "mission is ambiguous about the acceptance bar"

    report = verify_scenario(scn, local_test_runner, llm_check=judge)
    spec_check = next(c for c in report.checks if c.name == "spec_sufficiency")
    assert not spec_check.ok
    assert spec_check.advisory
    assert report.ok  # advisory failures don't sink the overall report


def test_immutability_flags_drift(tmp_path, monkeypatch):
    monkeypatch.setenv("BAKUDO_ENV", "dev")
    root = tmp_path / "scenarios"
    root.mkdir()
    make_bug_scenario(root)
    registry = ScenarioRegistry(root)
    scn = registry.get("add-bug@1")
    lockfile = root / "digests.lock"
    lockfile.write_text(json.dumps({scn.ref: "0" * 64}))

    registry = ScenarioRegistry(root)
    scn = registry.get("add-bug@1")
    report = verify_scenario(scn, local_test_runner)
    immut = next(c for c in report.checks if c.name == "immutability")
    assert not immut.ok
    assert not report.ok


def test_cli_scenario_list_json(monkeypatch, capsys):
    rc = main(["scenario", "list", "--json"])
    out = json.loads(capsys.readouterr().out)
    assert rc == 0
    assert len(out) == 5
    assert {"csv-sum-offbyone@1", "rate-limiter-fix@1"} <= {e["ref"] for e in out}


def test_cli_scenario_list_filters_by_family(monkeypatch, capsys):
    rc = main(["scenario", "list", "--family", "no-change", "--json"])
    out = json.loads(capsys.readouterr().out)
    assert rc == 0
    assert [e["ref"] for e in out] == ["rate-limiter-nochange@1"]


def test_cli_verify_json(monkeypatch, capsys):
    monkeypatch.setenv("BAKUDO_ENV", "dev")
    rc = main(["scenario", "verify", "csv-sum-offbyone", "--json"])
    out = json.loads(capsys.readouterr().out)
    assert rc == 0
    assert out["ok"] is True
    assert [c["name"] for c in out["checks"]] == list(CHECK_ORDER)


def test_cli_verify_exits_nonzero_without_dev_env(monkeypatch, capsys):
    monkeypatch.delenv("BAKUDO_ENV", raising=False)
    rc = main(["scenario", "verify", "csv-sum-offbyone"])
    err = capsys.readouterr().err
    assert rc == 2
    assert "BAKUDO_ENV" in err


def test_cli_scenario_scaffold_writes_template_and_refuses_overwrite(tmp_path, monkeypatch):
    monkeypatch.setattr("bakudo.paths.scenarios_dir", lambda: tmp_path)

    rc = main(["scenario", "scaffold", "new-scenario", "--family", "debugging"])
    assert rc == 0
    d = tmp_path / "new-scenario"
    assert (d / "scenario.yaml").is_file()
    assert (d / "fixture" / "README.md").is_file()
    assert (d / "hidden" / "README.md").is_file()
    assert (d / "reference" / "README.md").is_file()
    text = (d / "scenario.yaml").read_text()
    assert "canary GUID" in text
    assert "family: debugging" in text

    rc = main(["scenario", "scaffold", "new-scenario", "--family", "debugging"])
    assert rc == 1


def test_missing_hidden_test_file_fails_cleanly_not_crash(tmp_path, monkeypatch):
    """hidden.failToPass naming a file that isn't actually on disk (a stale
    entry, or -- as review found -- exactly what `bakudo scenario scaffold`
    leaves behind before its hidden/test_TODO.py placeholder is filled in)
    must surface as a failing check with an actionable path, never a raw
    FileNotFoundError traceback."""
    monkeypatch.setenv("BAKUDO_ENV", "dev")
    root = tmp_path / "scenarios"
    root.mkdir()
    make_bug_scenario(root)

    scenario_yaml = root / "add-bug" / "scenario.yaml"
    spec = yaml.safe_load(scenario_yaml.read_text())
    spec["hidden"]["failToPass"] = ["hidden/does-not-exist.py"]
    scenario_yaml.write_text(yaml.safe_dump(spec, sort_keys=False))

    registry = ScenarioRegistry(root)
    scn = registry.get("add-bug@1")

    report = verify_scenario(scn, local_test_runner)  # must not raise

    ftp = next(c for c in report.checks if c.name == "fail_to_pass_pristine")
    assert not ftp.ok
    assert "does-not-exist.py" in ftp.detail
    assert not report.ok


def test_cli_scaffold_then_verify_fails_cleanly_with_exit_code_1(tmp_path, monkeypatch, capsys):
    """End-to-end repro from review: `scaffold` then `verify` on the
    untouched placeholder must yield a clean failing report (rc=1) through
    main(), not a crash -- and doubles as the CLI-level exit-code-1 test for
    a failing non-advisory check."""
    monkeypatch.setenv("BAKUDO_ENV", "dev")
    monkeypatch.setattr("bakudo.paths.scenarios_dir", lambda: tmp_path)

    rc = main(["scenario", "scaffold", "demo", "--family", "debugging"])
    assert rc == 0
    capsys.readouterr()  # discard scaffold's own stdout

    rc = main(["scenario", "verify", "demo", "--json"])
    captured = capsys.readouterr()
    assert rc == 1
    out = json.loads(captured.out)
    assert out["ok"] is False
    failing = [c for c in out["checks"] if not c["ok"]]
    assert failing
    assert any("hidden test file not found" in c["detail"] for c in failing)
