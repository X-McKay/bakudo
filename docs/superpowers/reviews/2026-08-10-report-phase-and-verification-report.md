# Report-phase restructure + independent verification — session report

Session 2 of the post-refactor hardening (2026-08-09/10). Merged to main as
PR #43 (`fix/run-report-extraction`, issues #27+#28) and PR #44
(`improve/optimize-cycle-costs`). Companion docs: the 2026-08-09 e2e
validation report (rungs 1–10) and findings beside this file.

## Verdict

The optimize loop's two terminal outcomes are now both **live-proven**:

- **Verified winner** — a live cycle on the optfix fixture selected a real
  O(n²)→O(n) fix, all 7 suites passing (overall 0.908, cost 0.61), and the
  claim reproduced under independent measurement (0.95s → 0.06s):
  `status: improved, bench_verified: true`.
- **Verified refusal** — with only a bench-blind inefficiency left, a
  3-round cycle rejected every attempt for the *right* reasons — including a
  round-2 winner whose claimed speedup measured **−5%** under independent
  re-bench and was discarded (the OPT-3 scenario caught in production) —
  ending in an honest `no-change` with all three rounds' feedback
  accumulated (OPT-17 fixed).

## What changed (issue #27 — the structural fix)

The run report is no longer a side effect of the final message of an
unbounded loop. `build_and_run` now runs the loop to *some* ending — clean
finish, `LoopHalt`, or a maxTokens clip — and always falls through to one
unconditional report-extraction phase:

- **`LoopHalt` hierarchy** (`strands_tools/build.py`): `BudgetExceeded`
  (timeout / token cap / **tool-call ceiling**) and `DenialsExhausted` (the
  tripped denial circuit-breaker now *ends the loop* instead of just
  disabling commands), raised deterministically from `check_budget` at both
  tool entry and the after-model-call hook.
- **Spec-level `budget.maxToolCalls`** (schema + models + `budget_from_spec`
  → `ToolContext.tool_call_ceiling`): scout 25, attempt 60.
- **Report phase**: `ctx.begin_report_phase()` disarms budget enforcement so
  the one bounded extraction call cannot be killed by the budget that ended
  the loop; halted runs are coerced to `blocked` with the halt reason
  appended; extraction failure falls back to ending-specific text and now
  logs to guest stderr.
- **Loop-hole closed** (both mirrors): a blocked scout with no followups is
  `scout-failed` (one retry, then a distinct status) — never the "code is
  already optimal" `no-change`. Shared predicate: `scout_run_failed`.

## What changed (issue #28 — independent bench verification)

`select_winner`'s pick is re-benched before it is trusted, in both mirrors
(`_verified_winner` in-process; `measure_winner_bench` activity in
`OptimizationWorkflow`):

- The agent branch does **not** survive `abox stop --clean`; the collected
  diff is the only re-benchable artifact (`AgentRunOutput` now carries it).
- The diff is applied **host-side** onto a temporary `verify/<id>` branch
  (file content only — abox's in-guest proxy denies `git apply`), then two
  fresh `--network safe` sandboxes time the bench **best-of-3** per ref.
- A claim that doesn't reproduce (>5% measured floor,
  `BENCH_VERIFY_MIN_IMPROVEMENT`) rejects that candidate with next-round
  feedback and selection falls through to the next eligible attempt.

## The session's live failure ladder (rungs 11–16)

Each rung was found in a real cycle, root-caused offline, fixed with a
pinned test:

11. **strands ≥1.45 breaks structured output on vLLM** — its OpenAI-provider
    `structured_output` sends `tools: []`, which vLLM 400-rejects, so every
    in-guest extraction silently fell back. Bisected live: 1.44.0 OK,
    1.45.0/1.50.0/1.51.0 FAIL. Pinned `strands-agents>=1.43,<1.45`.
12. Models use `cd`/shell chaining → one benign denial trips the
    (deliberately strict) any-denial safety gate, vetoing otherwise-winning
    diffs → role prompts now forbid it. The gate itself was not weakened.
13. Guided extraction dropped `tests_run` → task-gate failure → the
    extraction prompt demands `{command, status}` entries.
14. **abox guest proxy denies `git apply`** → verification redesigned to
    host-side apply + two-sandbox timing (above).
15. A scout recorded its denied test attempt as `status: "denied"`; the
    schema enum rejected it and `normalize_result` raised *outside*
    `main.run`'s guard → runner crashed with **no result.json**. Unknown
    test statuses now coerce to `error`, and normalization failures write a
    failed-but-diagnosable result built directly from `RunResult`.
16. Failed runs were undiagnosable (three blind cycles) → `run_sandbox`
    payloads and loop feedback now carry sandbox error + stderr tails. This
    caught rung 15 on its first flight.

Also fixed: transient guest→vLLM ConnectTimeouts (client now retries 5× with
a 15s connect timeout); the scout burning denials on the advertised bench
command (now marked context-only in the scout objective); attempt token
spend halved via `enableThinking: false` (cost suite 0.28 → 0.61).

## Operational notes

- Rebuild + re-vendor the wheel (`make wheel`, force-reinstall prepare,
  `abox env warm --force`) after any runner-side change; verify with the
  pipcheck probe before burning a cycle.
- The optfix fixture (`~/git/optfix`) currently has `dedupe()` optimized and
  `count_new()` as a bench-blind planted inefficiency — the multi-round /
  no-change test state. Revert `dedupe()` to the `item not in out` loop to
  retest the winner path.
- Final gate: ruff clean, mypy clean, **417 passed / 9 skipped**.
