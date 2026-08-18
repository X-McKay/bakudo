"""Live e2e: the abox-backed verifier-test runner (Task 8) exercised through
the CLI's ``trial``/``experiment`` commands against a real abox 0.7.1
sandbox. Gated exactly like ``tests/test_abox_live.py`` -- skipped unless
``ABOX_LIVE=1`` (needs KVM; the workspace abox_verifier_runner grades verifier
tests in gets a synthetic python-glibc ``.abox/`` of its own -- see
``bakudo.abox.verifier._ensure_guest_environment`` -- and its fixed
content must be ``abox project trust``-ed once on this machine, same class
of prerequisite as test_abox_live's "trusted, warmed abox project").

(a) requires a real, live model endpoint (``VLLM_BASE_URL``/``VLLM_API_KEY``
et al., same forwarding as ``bakudo.abox.runner``) -- ``BAKUDO_OFFLINE=0`` is
set explicitly here rather than assumed ambient, since every other CLI path
defaults it to ``1``. (b) deliberately stays offline (the CLI's own
``BAKUDO_OFFLINE=1`` default): its ``no-change`` tasks grade a real,
non-vacuous ``passToPass`` list against the unmodified fixture through
abox_verifier_runner, so it validates the abox-guest grading path for real
without depending on a live model endpoint being reachable.
"""

from __future__ import annotations

import json
import os

import pytest

pytestmark = [
    pytest.mark.live_abox,
    pytest.mark.skipif(
        os.environ.get("ABOX_LIVE") != "1",
        reason="live abox e2e: set ABOX_LIVE=1 (needs KVM + trusted abox_verifier_runner "
        "synthetic project -- see bakudo.abox.verifier._ensure_guest_environment)",
    ),
]


def test_cli_trial_run_live_abox_grades_real_verifier_tests(monkeypatch, capsys):
    """One live trial of csv-sum-offbyone with a real agent: the pipeline
    (in-process, real model call) produces a diff, and verifier-test grading
    runs for real inside an abox guest (BAKUDO_SANDBOX=abox, not the
    BAKUDO_ENV=dev local runner) -- the TrialRecord's rates are whatever the
    real run actually produced, not a stub."""
    from bakudo.cli import main

    monkeypatch.delenv("BAKUDO_ENV", raising=False)
    monkeypatch.setenv("BAKUDO_SANDBOX", "abox")
    monkeypatch.setenv("BAKUDO_OFFLINE", "0")
    # Isolated from whatever ledger an operator's ambient .env configures
    # (e.g. BAKUDO_POSTGRES_DSN): this test's job is the abox-backed verifier
    # runner, not durable persistence -- ledger_from_env()'s in-memory
    # fallback keeps it that way, same as every other non-durable-ledger CLI
    # test in this suite.
    monkeypatch.delenv("BAKUDO_POSTGRES_DSN", raising=False)

    rc = main(
        [
            "trial",
            "run",
            "csv-sum-offbyone",
            "--agent",
            "add-feature@1",
            "--seed",
            "11",
            "--json",
        ]
    )
    out = capsys.readouterr()
    assert rc == 0, out.err

    record = json.loads(out.out)
    assert record["agent_ref"] == "add-feature@1"
    assert record["task_name"] == "csv-sum-offbyone"
    assert record["status"] == "completed"

    evaluation = record["evaluation"]
    assert isinstance(evaluation["f2p_rate"], float)
    assert isinstance(evaluation["p2p_rate"], float)
    # Real grading, not a stub short-circuit: a genuine detail string from
    # trials.verifier.evaluate's pytest-tail-derived report.
    assert evaluation["detail"]


def test_cli_experiment_profile_live_abox_smoke(monkeypatch, capsys):
    """`bakudo experiment profile <agent> --family no-change --count 2`
    through main(): rc 0, parseable JSON. Grades through the real abox
    guest (BAKUDO_SANDBOX=abox); the pipeline itself stays offline (the
    CLI's own BAKUDO_OFFLINE=1 default) so this doesn't depend on a live
    model endpoint -- the no-change family's non-empty passToPass list
    still exercises real abox_verifier_runner grading against the unmodified
    fixture."""
    from bakudo.cli import main

    monkeypatch.delenv("BAKUDO_ENV", raising=False)
    monkeypatch.setenv("BAKUDO_SANDBOX", "abox")
    # See the sibling test: isolate from an operator's ambient durable-ledger
    # config, this smoke test's job is the abox-backed verifier runner.
    monkeypatch.delenv("BAKUDO_POSTGRES_DSN", raising=False)

    rc = main(
        [
            "experiment",
            "profile",
            "add-feature@1",
            "--family",
            "no-change",
            "--count",
            "2",
            "--json",
        ]
    )
    out = capsys.readouterr()
    assert rc == 0, out.err

    result = json.loads(out.out)
    assert result["profile"] is True
    assert result["baseline"] == "add-feature@1"
    assert result["candidates"] == []
