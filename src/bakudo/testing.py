"""Deterministic test doubles for the run pipeline (§6.2 of the roadmap).

:class:`FauxDriver` is a scriptable sandbox driver: it satisfies the
``SandboxFn`` contract (``TaskBundle -> AboxOutcome``) and plays back a
scripted sequence of :class:`FauxRun` outcomes, so the *entire* pipeline —
bundle -> sandbox -> normalize -> budgets -> eval suite -> scorecard ->
promotion — can be exercised end-to-end with zero model calls and byte-stable
results. Use it in unit tests, Temporal workflow tests, and the CI eval gate.

This module ships in the package (not tests/) on purpose: the CI eval-gate
script and downstream users' tests both need it.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from itertools import count

from .abox.runner import AboxOutcome
from .bundle import TaskBundle
from .ids import git_branch_for


@dataclass
class FauxRun:
    """One scripted sandbox outcome.

    Only the fields a test cares about need setting; everything else defaults
    to a clean, schema-valid success.
    """

    status: str = "success"
    summary: str = "faux run"
    changed_files: list[str] = field(default_factory=list)
    diff: str = ""
    tests: list[tuple[str, str]] = field(default_factory=list)  # (command, status)
    metrics: dict[str, float] = field(default_factory=dict)
    blocked_reasons: list[str] = field(default_factory=list)
    proposed_followups: list[str] = field(default_factory=list)
    denied_commands: list[dict[str, str]] = field(default_factory=list)
    runtime_seconds: float = 1.0
    tokens_used: int = 1000
    # Overrides for failure-shape testing:
    exit_code: int | None = None       # default: 0 unless status == "failed"
    raw_result: dict | None = None     # replaces the generated result entirely
    result_missing: bool = False       # sandbox "succeeded" but produced no result


class FauxDriver:
    """Plays back scripted :class:`FauxRun` outcomes as a ``SandboxFn``.

    Runs are consumed in order; when the script is exhausted the last run
    repeats (convenient for fan-outs of unknown size). Every produced outcome
    is recorded in ``calls`` alongside the bundle it answered, so tests can
    assert on what the pipeline actually sent to the sandbox.
    """

    def __init__(self, runs: list[FauxRun]):
        if not runs:
            raise ValueError("FauxDriver needs at least one scripted run.")
        self._runs = list(runs)
        self._counter = count()
        self.calls: list[tuple[TaskBundle, AboxOutcome]] = []

    def __call__(self, bundle: TaskBundle) -> AboxOutcome:
        index = next(self._counter)
        faux = self._runs[min(index, len(self._runs) - 1)]

        if faux.raw_result is not None:
            result: dict | None = dict(faux.raw_result)
        elif faux.result_missing:
            result = None
        else:
            result = {
                "run_id": bundle.run_id,
                "agent": bundle.agent_spec.ref,
                "objective_id": bundle.objective_id,
                "status": faux.status,
                "summary": faux.summary,
                "changed_files": list(faux.changed_files),
                "tests_run": [
                    {"command": command, "status": status}
                    for command, status in faux.tests
                ],
                "metrics": dict(faux.metrics),
                "blocked_reasons": list(faux.blocked_reasons),
                "proposed_followups": list(faux.proposed_followups),
            }

        exit_code = faux.exit_code
        if exit_code is None:
            exit_code = 1 if faux.status == "failed" else 0

        outcome = AboxOutcome(
            run_id=bundle.run_id,
            abox_task_id=bundle.run_id,
            exit_code=exit_code,
            git_branch=git_branch_for(bundle.run_id),
            result=result,
            diff=faux.diff,
            changed_files=list(faux.changed_files),
            denied_commands=list(faux.denied_commands),
            runtime_seconds=faux.runtime_seconds,
            tokens_used=faux.tokens_used,
            stdout=json.dumps(result) if result else "",
        )
        self.calls.append((bundle, outcome))
        return outcome
