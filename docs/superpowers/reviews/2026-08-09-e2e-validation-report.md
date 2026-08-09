# abox 0.6.0 end-to-end validation — final report

Branch: `validate/abox-0.6.0-e2e` (67 commits over `main@d78555c`), 2026-08-09.
Companions: findings in `2026-08-09-post-refactor-review-findings.md`, plan in
`docs/superpowers/plans/2026-08-09-abox-0.6.0-e2e-validation.md`, promotion
design in `docs/superpowers/specs/2026-08-09-promotion-lifecycle-design.md`.

## Verdict

The meta-redesign's **offline plane was solid; its production plane had never
executed**. After a five-subsystem review (~80 findings, 9 blockers) and three
waves of repair, the production stack now runs end-to-end against the live
cluster and the real abox 0.6.0 binary. Final gate: **ruff clean, mypy clean,
377 passed / 9 skipped** (skips = live-marked tests, opt-in via env).

## Proven live (with evidence)

| Capability | Evidence |
|---|---|
| Real abox 0.6.0 sandboxing | `ABOX_LIVE=1` tests green ×2 machines/paths; offline in-sandbox e2e (`run_E2EOFF1`): schema-valid result via `abox path`, clean teardown, exit-124 timeout semantics |
| Durable run pipeline (Temporal 1.29.1 + PG) | `run_E2EDUR2`: workflow completed on ns `bakudo`; ledger row with both timestamps; exact idempotent event sequence; objective upserted; child eval workflow ran |
| **Full production flagship** | `run_E2ELIVE5`: durable workflow → microVM → strands agent → 12 live 35B calls through scoped egress → 32 tool calls (3 denied, visible to evals) → schema-valid result → 6 suites persisted. 104k tokens, 127s |
| Sandboxed critic (approved design §5) | Live `critic_eval`: passed=True, score 0.6, 4 substantive issues from a read-only microVM review |
| Policy enforcement (adversarial) | A live scout attempted ~40 escalating write bypasses (sed/awk); every one denied; run bounded |
| Promotion lifecycle | 80 new tests incl. WorkflowEnvironment coverage: status machine, active-only spawn, hash-canary routing, ledger-backed graduation/rollback, §25.3 approve/reject from stored scorecards |
| Semantic memory (code-level) | Live-marked round-trip suite green against a local pgvector container; real 1024-dim embedder wired; **live-cluster pgvector is broken — see below** |
| API surface | Auth on every route (self-checking matrix), fail-closed sandbox policy on all execution paths (API + CLI), body-resolution regression guards |
| CI | Installs `[all,dev]`; 0 hidden skips; smoke incl. demo + optimize |

## Infrastructure findings needing operator action

1. **pgvector on the live Postgres crashes the server** (signal 4, Illegal
   instruction, first real vector op; bitnami PG 18.3 + vector 0.8.2 —
   build/CPU mismatch). Ledger SQL is unaffected. Do not run semantic-memory
   writes/queries against the live DB until the extension binary matches the
   node CPU. Details + acceptance in HUMAN_TASKS §2.
2. **Stale Rust `bakudo` at `~/.cargo/bin/bakudo`** shadows the Python CLI on
   the worker host PATH — remove it.
3. Live server is PG 18.3 (not 17 as previously recorded); Temporal 1.29.1,
   namespace `bakudo`; all three vLLM endpoints healthy, reasoning parser
   active, per-request `enable_thinking` honored.

## The live-model failure ladder (all fixed on this branch)

Each rung was a real, previously-unexecuted seam; fixes are individually
committed with pinned tests:

1. Guest lacked the `[runtime]` extra → prepare installs it.
2. strands `@tool` rejects `functools.partial` (predicted as ABOX-19) →
   named-callable adapter.
3. Sandboxes forked `main`, not the branch under test → `BAKUDO_BASE_REF`.
4. `networkMode: none` → abox `safe` blocked the agent's own model call →
   live roles declare `scoped` (bounded by the trusted project domain list).
5. Placeholder modelIds → mapped to hosted `Qwen3.6-35B-A3B-FP8`.
6. Thinking model clipped structured outputs (critic, scout) → cause-chain
   summaries, truncation salvage, `enableThinking:false` for structured roles
   (verified live: 4-token direct answers).
7. Failed scouts masqueraded as "no-change" (OPT-12) → distinct
   `scout-failed` + one retry, in both loop mirrors.
8. Vendored-wheel version skew (pip same-version skip; warm fingerprint blind
   to wheel bytes) → `make wheel` SHA-stamped versions, force-reinstall
   prepare, `abox env warm --force`, and a diagnosable `bundle_incompatible`
   failed result on any future skew.
9. Model narrated followups in prose, arrays empty → strands structured-output
   extraction with explicit instructions (restores the pre-redesign contract).
10. Scout retry-looped against the policy wall (100+ calls) → denial
    circuit-breaker (hard stop after 5) + instructive denial messages.

## Known-open: optimize-cycle robustness (structural)

The live optimize cycle still ends without a winner: the scout wanders within
allowed commands until wall-clock, and the `blocked` ending bypasses report
extraction (loop treats it as "nothing to do"). Root cause is structural —
**the deliverable is a side effect of the final message of an unbounded
loop**; every loop-ending variant is a way to lose it. The agreed fix
(deliberately deferred to an issue rather than another patch): one mandatory
report-extraction phase on *every* ending + a per-role `maxToolCalls` ceiling
that force-transitions to reporting. Tracked with the other deferred items.

## Deferred work

Filed as GitHub issues (label `post-refactor-review`): the structural report
phase above; independent bench verification for winner selection (OPT-3);
FalkorDB graph-memory migration (mirror frozen this branch); pgvector infra
fix; incremental `write-result` drafts; version handshake; strands
`structured_output` deprecation; corpus loader validation; evolution suite
selection; scout feedback accumulation; targetPaths enforcement; compose
worker image; assorted minors (see issues for the full list).

## Operational runbook deltas

- Target repos need `.abox/project.toml` + vendored SHA-stamped wheel +
  force-reinstall prepare + trust + warm (`--force` after wheel-only changes).
- Worker env: `TEMPORAL_NAMESPACE=bakudo`, `BAKUDO_SANDBOX=abox`,
  `BAKUDO_REPO_ROOT`, `VLLM_*`; `VLLM_EMBED_URL` is mandatory with the DSN;
  leave `NEO4J_URI` unset until FalkorDB lands.
- `pytest -m live` and `ABOX_LIVE=1 pytest tests/test_abox_live.py` are the
  opt-in live gates.
