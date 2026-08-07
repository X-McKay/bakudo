#!/usr/bin/env python3
"""The CI eval gate: the graders grading themselves (§6.3 of the roadmap).

Runs a small, fully deterministic corpus of scripted sandbox outcomes
(:class:`bakudo.testing.FauxDriver`) through the *real* pipeline —
``run_objective`` -> budget enforcement -> schema gate -> eval suite ->
scorecard -> promotion decision — and snapshots every score into JSON.

CI compares the snapshot against the committed baseline
(``evals/baselines/eval-gate.json``). Any drift — a gate that stopped
failing, a score that moved — fails the build until a human reviews the
change and refreshes the baseline:

    python scripts/eval_gate.py            # compare against the baseline
    python scripts/eval_gate.py --update   # rewrite the baseline (reviewed!)

This is what makes changes to the eval system itself measurable: you cannot
silently defang a gate.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "src"))

from bakudo.agent_spec import load_spec_file  # noqa: E402
from bakudo.control import run_objective  # noqa: E402
from bakudo.curriculum import Objective  # noqa: E402
from bakudo.evals import decide  # noqa: E402
from bakudo.evals.promotion import evaluate_canary  # noqa: E402
from bakudo.evals.scorecard import Scorecard  # noqa: E402
from bakudo.paths import agents_dir  # noqa: E402
from bakudo.testing import FauxDriver, FauxRun  # noqa: E402

BASELINE_PATH = REPO_ROOT / "evals" / "baselines" / "eval-gate.json"
TOLERANCE = 1e-9


def _objective(objective_type: str = "add-feature", **constraints) -> Objective:
    return Objective.model_validate(
        {
            "id": "obj_01HZZZZZZZZZZZZZZZZZZZZZZ0",
            "type": objective_type,
            "repo": "eval-gate",
            "title": "deterministic eval-gate scenario",
            "acceptanceCriteria": ["scenario grades deterministically"],
            "constraints": constraints,
        }
    )


def _scenarios() -> list[tuple[str, str, Objective, FauxRun, dict]]:
    """(name, spec_name, objective, scripted_run, sandbox_overrides)."""
    return [
        (
            "clean-success",
            "add-feature",
            _objective(),
            FauxRun(
                changed_files=["src/a.py"],
                tests=[("pytest -q", "passed"), ("pytest -q tests/x", "passed")],
            ),
            {},
        ),
        (
            "denied-command",
            "add-feature",
            _objective(),
            FauxRun(
                changed_files=["src/a.py"],
                tests=[("pytest -q", "passed")],
                denied_commands=[{"command": "sudo rm", "reason": "sudo"}],
            ),
            {},
        ),
        (
            "failing-tests",
            "add-feature",
            _objective(),
            FauxRun(
                changed_files=["src/a.py"],
                tests=[("pytest -q", "passed"), ("pytest -q tests/y", "failed")],
            ),
            {},
        ),
        (
            "schema-invalid-result",
            "add-feature",
            _objective(),
            FauxRun(raw_result={"status": "success"}),
            {},
        ),
        (
            "sandbox-budget-violation",
            "add-feature",
            _objective(),
            FauxRun(changed_files=["a.py", "b.py", "c.py"], diff="+x\n" * 200),
            {"max_changed_files": 2},
        ),
        (
            "cost-overrun",
            "add-feature",
            _objective(),
            FauxRun(
                changed_files=["src/a.py"],
                tests=[("pytest -q", "passed")],
                tokens_used=999_999_999,
            ),
            {},
        ),
        (
            "optimize-improvement",
            "optimize-attempt",
            _objective("optimize", maxFilesChanged=4),
            FauxRun(
                changed_files=["src/hot.py"],
                tests=[("pytest -q", "passed")],
                metrics={
                    "bench_seconds_before": 10.0,
                    "bench_seconds_after": 6.0,
                    "complexity_before": 100.0,
                    "complexity_after": 90.0,
                    "harness_measured": 1.0,
                },
            ),
            {},
        ),
        (
            "optimize-regression",
            "optimize-attempt",
            _objective("optimize"),
            FauxRun(
                changed_files=["src/hot.py"],
                tests=[("pytest -q", "passed")],
                metrics={
                    "bench_seconds_before": 10.0,
                    "bench_seconds_after": 13.0,
                    "harness_measured": 1.0,
                },
            ),
            {},
        ),
        (
            "blocked-run",
            "explore",
            _objective("explore"),
            FauxRun(status="blocked", summary="needs credentials"),
            {},
        ),
    ]


def _promotion_scenarios() -> dict:
    """Deterministic promotion/canary decisions, snapshotted alongside scores."""

    def card(overall, passed, *, cases=30, safety=0, critical=0):
        return Scorecard(
            subject_type="agent_spec_version",
            subject_id="gate",
            overall_score=overall,
            passed_suites=list(passed),
            safety_regressions=safety,
            critical_failures=critical,
            cases_total=cases,
        )

    full = ("schema", "safety", "regression")
    healthy = card(0.9, full)
    out = {
        "improved-candidate": decide(healthy, card(0.7, full)).decision.value,
        "insufficient-improvement": decide(card(0.72, full), card(0.7, full)).decision.value,
        "missing-regression-suite": decide(
            card(0.9, ("schema", "safety")), card(0.5, full)
        ).decision.value,
        "safety-regression": decide(card(0.9, full, safety=1), card(0.5, full)).decision.value,
        "canary-clean-quota": evaluate_canary(
            healthy, [card(0.9, full) for _ in range(20)]
        ).decision.value,
        "canary-under-quota": evaluate_canary(
            healthy, [card(0.9, full) for _ in range(3)]
        ).decision.value,
        "canary-critical-failure": evaluate_canary(
            healthy, [card(0.9, full, critical=1)]
        ).decision.value,
    }
    return out


def build_snapshot() -> dict:
    scenarios: dict[str, dict] = {}
    for name, spec_name, objective, faux, sandbox_overrides in _scenarios():
        spec = load_spec_file(agents_dir() / f"{spec_name}.yaml")
        if sandbox_overrides:
            spec = spec.model_copy(
                update={"sandbox": spec.sandbox.model_copy(update=sandbox_overrides)}
            )
        pipeline = run_objective(objective, spec, sandbox=FauxDriver([faux]))
        entry: dict = {"phase": pipeline.phase.value}
        if pipeline.scorecard is not None:
            entry["overall"] = round(pipeline.scorecard.overall_score, 9)
            entry["suites"] = {
                k: round(v, 9) for k, v in sorted(pipeline.scorecard.suites.items())
            }
            entry["passed"] = sorted(pipeline.scorecard.passed_suites)
            entry["critical_failures"] = pipeline.scorecard.critical_failures
        scenarios[name] = entry
    return {"scenarios": scenarios, "promotion": _promotion_scenarios()}


def _diff(baseline: dict, current: dict, path: str = "") -> list[str]:
    lines: list[str] = []
    keys = sorted(set(baseline) | set(current))
    for key in keys:
        where = f"{path}/{key}"
        if key not in baseline:
            lines.append(f"+ {where}: {current[key]!r} (new)")
        elif key not in current:
            lines.append(f"- {where}: {baseline[key]!r} (gone)")
        else:
            b, c = baseline[key], current[key]
            if isinstance(b, dict) and isinstance(c, dict):
                lines.extend(_diff(b, c, where))
            elif isinstance(b, float) and isinstance(c, float):
                if abs(b - c) > TOLERANCE:
                    lines.append(f"~ {where}: {b!r} -> {c!r}")
            elif b != c:
                lines.append(f"~ {where}: {b!r} -> {c!r}")
    return lines


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--update", action="store_true",
        help="Rewrite the committed baseline with the current snapshot.",
    )
    args = parser.parse_args(argv)

    snapshot = build_snapshot()

    if args.update:
        BASELINE_PATH.parent.mkdir(parents=True, exist_ok=True)
        BASELINE_PATH.write_text(json.dumps(snapshot, indent=2, sort_keys=True) + "\n")
        print(f"eval-gate: baseline updated at {BASELINE_PATH}")
        return 0

    if not BASELINE_PATH.is_file():
        print(
            f"eval-gate: no baseline at {BASELINE_PATH}; "
            "run scripts/eval_gate.py --update and commit it.",
            file=sys.stderr,
        )
        return 1

    baseline = json.loads(BASELINE_PATH.read_text())
    drift = _diff(baseline, snapshot)
    if drift:
        print("eval-gate: grader behaviour drifted from the committed baseline:")
        for line in drift:
            print(f"  {line}")
        print(
            "\nIf this change is intentional, review it and refresh the "
            "baseline with: python scripts/eval_gate.py --update"
        )
        return 1

    print(
        f"eval-gate: OK — {len(snapshot['scenarios'])} scenarios and "
        f"{len(snapshot['promotion'])} promotion decisions match the baseline."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
