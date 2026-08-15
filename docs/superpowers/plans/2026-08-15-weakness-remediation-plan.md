# Remediation plan: review findings (2026-08-15)

This plan sequences fixes for the weaknesses and minor issues surfaced in the
2026-08-15 in-depth review. It is grouped into four phases by risk and
dependency order. Each item states the **problem**, **root cause**, **files**,
**approach**, **tests**, and a rough **effort** (S ≤ half-day, M ≤ 2 days,
L > 2 days).

Guiding principle for the whole plan: **close the gap between what the docs
claim is enforced and what the code enforces** — either wire the control up, or
correct the doc. No finding is an architectural dead-end; these are the
"safe to leave running unattended under real concurrency" layer.

The offline quality gate for every item is `make check` (ruff + mypy + pytest).
Postgres/graph items additionally need the opt-in live suites
(`pytest -m live`, `tests/test_store_pg_live.py`, `tests/test_graph_falkor_live.py`).

---

## Phase 0 — Trivially safe correctness + honesty (do first)

Low-risk, high-signal changes that remove misleading state and a known-bad
dependency resolution. No behavioral coupling; land as one small PR.

### 0.1 Fix the `all` extra strands pin (Minor #11) — S
- **Problem:** `pyproject.toml` `all` extra declares `strands-agents>=0.1`
  (unbounded), contradicting the documented, live-bisected cap
  `strands-agents>=1.43,<1.45` in the `runtime` extra. `pip install .[all]`
  can resolve a strands the project *knows* breaks vLLM structured output; CI
  is green only by luck of resolution.
- **Root cause:** the pin was added to `runtime` but the duplicated `all` list
  was not updated.
- **Files:** `pyproject.toml` (line ~45).
- **Approach:** change the `all` entry to `strands-agents>=1.43,<1.45` to match
  `runtime`. Consider collapsing `all` to reference the other extras
  (`bakudo[temporal,db,runtime,api]`) so there is a single source of truth for
  every pin and this class of drift cannot recur.
- **Tests:** CI resolution; add a tiny test asserting the `runtime` and `all`
  strands specifiers are identical (parse `pyproject.toml`), so future drift
  fails fast.
- **Effort:** S.

### 0.2 Remove dead/cosmetic state (Minor #12) — S
- **Problem:** two pieces of state that gate nothing and mislead readers:
  - `DECISION_TO_VERSION_STATUS[Decision.promote] = "active"`
    (`evals/promotion.py`) is never reached — `_decide` only ever returns
    `reject`/`needs_human`/`canary`; activation happens exclusively via
    `check_canary_graduation` → `set_version_status`.
  - `RepoObserverWorkflow.iterations` (`temporal/workflows.py`,
    `temporal/shared.py`) is carried through input and "reset at 32" but each
    execution does exactly one collect+sleep+Continue-As-New regardless, so
    the counter controls nothing.
- **Approach:** drop the unreachable map entry (or add a comment + assertion
  documenting that `promote` is control-plane-only and unreachable from
  `decide()`); remove `iterations` from `RepoObserverInput` and the workflow,
  or wire it to an actual batch-size / backoff decision if one is wanted.
  Prefer deletion — carry state only if it drives a decision.
- **Files:** `evals/promotion.py`, `temporal/workflows.py`, `temporal/shared.py`,
  their tests.
- **Tests:** update `test_promotion_lifecycle.py`, observer tests.
- **Effort:** S.

### 0.3 Collapse redundant ledger writes (parity nit) — S
- **Problem:** `AgentRunWorkflow` calls `_advance` twice back-to-back
  (`sandbox_starting` → `agent_running`) with no work between, costing two
  `persist_run` activity round-trips per run for no state change.
- **Approach:** collapse to a single transition, or document why both phases
  are persisted (dashboard granularity). If kept, batch them into one activity
  call.
- **Files:** `temporal/workflows.py`.
- **Tests:** `test_temporal_workflows.py` phase-sequence assertions.
- **Effort:** S.

---

## Phase 1 — Postgres/graph correctness (highest-severity bugs)

These are real defects on the durable memory/ledger paths that only bite under
live concurrency, which is exactly the target deployment. They are independent
of each other and each shippable alone, but share the live-suite gate.

### 1.1 `PgSemanticMemoryStore` thread-safety (Weakness #4) — M
- **Problem:** the store holds one `self._conn` and its own docstring says
  "multiple threads share one store." A single psycopg connection is **not**
  thread-safe; concurrent worker threads issuing statements corrupt the wire
  protocol. `PostgresLedger` already solved this by opening a short-lived
  connection per call (TMP-1) — this store did not adopt the fix.
- **Approach:** two viable options, recommend (b):
  - (a) Per-call short-lived connections mirroring `PostgresLedger`
    (`_connect()` context manager per public method). Simplest, matches the
    established pattern, no new dependency.
  - (b) A `psycopg_pool.ConnectionPool` created at `connect()`, checked out per
    operation. Better under high write rates; adds `psycopg-pool` to the `db`
    extra. **Recommended** because the memory write path is hotter than the
    ledger and benefits from pooling.
  - Keep the transactional-outbox atomicity: item + embedding + outbox enqueue
    must stay inside one transaction on the checked-out connection.
  - Update the class docstring to state the real concurrency contract.
- **Files:** `memory/store_pg.py`; `pyproject.toml` (if pool); `docs/operations.md`.
- **Tests:** extend `test_store_pg_live.py` with a concurrent-writers test
  (N threads writing distinct + colliding candidates; assert no protocol error,
  correct dedup/supersede, no zombie rows). Add an offline test that the store
  no longer retains a long-lived connection attribute across calls.
- **Effort:** M.

### 1.2 Atomic `resolve_promotion` (Weakness #5) — M
- **Problem:** in `PostgresLedger`, the status read, the status `UPDATE` (no
  `WHERE status='pending'` guard), and the cascading `set_version_status` run
  on **three separate** autocommit connections. TOCTOU: two resolvers can both
  pass the pending check; a crash mid-sequence leaves promotion and version
  state inconsistent.
- **Approach:** wrap the whole resolve in one transaction on one connection:
  `SELECT ... FOR UPDATE` the promotion row, verify `status='pending'`, do the
  `UPDATE promotion_decisions ... WHERE id=%s AND status='pending'` (guarded),
  and perform the cascading version transition in the same transaction. Return
  a clear "already resolved" result if the guarded update affects 0 rows,
  matching `InMemoryLedger` semantics.
- **Files:** `registry/postgres_ledger.py`; possibly `evals/promotion.py`
  (`apply_decision` call shape).
- **Tests:** live test with two concurrent resolvers (only one wins; state
  consistent); crash-injection style test asserting no partial transition
  (simulate by raising between update and cascade — should roll back).
- **Effort:** M.

### 1.3 Graph mirror durability + orphan fix (Weakness #6) — M
- **Problem:** two gaps in the FalkorDB mirror's otherwise-strong guarantees:
  - `record_run_edges` writes Run/AgentVersion/Objective/File edges **directly**
    to FalkorDB with no outbox — a graph outage silently loses run-provenance
    edges, unlike memory upsert/delete which are outboxed.
  - On **supersede-without-run-evidence**, `_supersede` skips both the old-node
    delete and the new upsert, but the old memory was already mirrored →
    Postgres holds the new id while the graph keeps an orphan `Memory` node
    referencing a deleted row, which the outbox never repairs.
- **Approach:**
  - Route `record_run_edges` through the same `graph_mirror_outbox` mechanism
    (enqueue an idempotent edge-upsert op inside the writing transaction; the
    single-drainer applies it). Reuse the existing dead-letter + advisory-lock
    drainer.
  - Fix `_supersede`: always enqueue a delete for the superseded node's id
    regardless of whether the replacement has run evidence (the delete is
    idempotent and correct even if the node was never mirrored). Only the
    *new* upsert is conditional on evidence.
  - Add a reconcile/GC pass (offline maintenance op) that finds graph `Memory`
    nodes with no live `memory_items` row and deletes them, as a backstop.
- **Files:** `memory/graph.py`, `memory/store_pg.py`.
- **Tests:** live graph test: supersede-without-evidence leaves no orphan;
  run-edge write survives a simulated graph outage (queued, then drained).
- **Effort:** M.

### 1.4 `set_version_status` parity + phantom-event fix (Weakness B, sub-item) — S
- **Problem:** Postgres `set_version_status` blind-updates with no existence
  check: for an unknown name/version it updates 0 rows yet still inserts an
  `agent_version_status` outbox event asserting the change, then returns
  `None`. `InMemoryLedger` raises `KeyError`. Divergent behavior + a false
  integration event.
- **Approach:** check affected-row count; if 0, do **not** emit the event and
  raise `KeyError` to match the in-memory ledger (the `Protocol` return type
  can then drop the `| None`). Emit the event only inside the same transaction
  as a successful update.
- **Files:** `registry/postgres_ledger.py`, `registry/ledger.py` (Protocol type).
- **Tests:** `test_postgres_ledger_live.py` — unknown version raises, no event
  row written; known version transitions and emits exactly one event.
- **Effort:** S.

### 1.5 Memory retrieval + dedup correctness (Weakness B, minors) — M
- **Problem:** three smaller correctness/parity issues:
  - `query(text=...)` applies `LIMIT` **before** the `min_similarity` filter →
    qualifying rows beyond the limit are lost and results can be short even when
    more matches exist.
  - Dedup inspects only the single nearest neighbour (`_nearest` limit 1); two
    distinct near-duplicates aren't collapsed.
  - In-memory `SemanticMemoryStore` supersedes the **first** insertion-order
    match while Postgres supersedes the **nearest** — a behavioral divergence.
- **Approach:** filter by `min_similarity` in SQL (`WHERE 1-(embedding<=>vec) >=
  %s`) then `ORDER BY ... LIMIT`; for dedup, consider the top-k neighbours above
  threshold and supersede/reject deterministically (nearest first) in both
  stores so behavior matches. Document the chosen dedup semantics in one place.
- **Files:** `memory/store_pg.py`, `memory/semantic.py`.
- **Tests:** offline `test_semantic_memory.py` for the ordering/threshold fix;
  live parity test asserting in-memory and PG stores make the same
  supersede/reject decision on a fixed candidate set.
- **Effort:** M.

### 1.6 `set_phase`/`finish_run` atomicity + `MemoryType` (nits) — S
- **Problem:** Postgres `set_phase`/`finish_run` run the row update and event
  insert as two separate autocommit statements (unlike `set_version_status`/
  `create_run` which are transactional). Separately, `MemoryType` enum exists
  but `MemoryItem.type` is a free `str` never validated against it.
- **Approach:** wrap the update+event pair in one transaction. Decide on
  `MemoryType`: either validate `type` against the enum (fail closed on unknown)
  or delete the unused enum. Prefer validation with the documented
  shorthand→canonical mapping actually applied in `compaction.py`.
- **Files:** `registry/postgres_ledger.py`, `memory/models.py`, `memory/compaction.py`.
- **Tests:** transactional rollback test; memory type validation test.
- **Effort:** S.

---

## Phase 2 — Governance that actually governs (autonomy safety)

The knobs an operator relies on to leave the system running. Highest
*product* impact: today these are plumbed through the API but constrain
nothing. Do after Phase 1 so the ledger/memory substrate they build on is sound.

### 2.1 Enforce budget + concurrency limits (Weakness #7) — L
- **Problem:** `budget_usd_remaining` and `role_concurrency` are settable via
  the Update API and readable via queries, but **never decremented, never
  consulted in `_can_dispatch`, never throttle dispatch**. `active_runs` is
  tracked but never used to throttle. The meta-agent dispatches one objective
  per loop with no real cost or concurrency ceiling.
- **Approach:**
  - **Concurrency:** in `_can_dispatch` / the dispatch loop, count in-flight
    runs per role from `active_runs` and refuse to dispatch when
    `role_concurrency[role]` (or a global cap) would be exceeded; the objective
    stays in `pending_backlog`. Depends on 2.3 (`active_runs` accuracy).
  - **Budget:** decide the accounting unit. Recommend tokens/cost reported by
    the run result (already captured: `tokens_used`, and the spec-side
    `budget.maxTokens`) rolled up per run into `budget_usd_remaining` via a
    pricing map keyed by `model.modelId`. Decrement on `run_completed`; block
    dispatch (and surface a `budget-exhausted` status) when the *estimated*
    next-run cost would breach the remaining budget. Keep the estimate replay-
    safe (pure, from spec + a static price table activity input — no wall clock).
  - Emit `get_budget_state` with real numbers.
- **Files:** `temporal/workflows.py` (`MetaState`, `_can_dispatch`, dispatch
  loop, `run_completed`), `temporal/shared.py`, `api/server.py` (surface state).
- **Tests:** `test_temporal_workflows.py`: dispatch is refused at the
  concurrency ceiling and resumes when a run completes; budget decrements on
  completion and blocks dispatch when exhausted; both survive Continue-As-New.
- **Effort:** L.

### 2.2 Route optimize objectives into `OptimizationWorkflow` (Weakness #8) — M
- **Problem:** `MetaAgentWorkflow.run` always starts `AgentRunWorkflow`, so an
  `optimize`-type objective from the curriculum runs as a **single scout run**,
  never the scout→attempt→verify loop. `OptimizationWorkflow` is only reachable
  out-of-band via `client.start_optimization` / `POST /optimize` — the
  best-engineered subsystem is disconnected from the autonomous path.
- **Approach:** in the dispatch loop, branch on `objective.type`: for
  `optimize`, start `OptimizationWorkflow` (child, `ParentClosePolicy.ABANDON`
  as with agent runs) with the optimize params derived from the objective
  (targetPaths, benchCommand, maxRounds, maxApproaches — extend the objective
  schema if these aren't yet first-class). Wire its terminal result back into
  `run_completed`/promotion the same way agent runs report. Ensure the
  optimize objective can carry a `benchCommand` (schema addition +
  `schemas/objective.schema.json`).
- **Files:** `temporal/workflows.py`, `temporal/shared.py`, `curriculum/objective.py`,
  `schemas/objective.schema.json`.
- **Tests:** `test_temporal_workflows.py`: an `optimize` objective dispatches an
  `OptimizationWorkflow`, not a bare `AgentRunWorkflow`; end-to-end via the
  existing offline optimize mirror.
- **Effort:** M.

### 2.3 Make `cancel` effective + reconcile `active_runs` (Weakness #9) — M
- **Problem:** `AgentRunWorkflow._cancelled` is checked only in the narrow
  window between bundle render and sandbox start; once `run_sandbox` is
  executing (the multi-hour part) the signal does nothing and is not propagated
  as activity cancellation. Separately, `active_runs` leaks: an ABANDON'd child
  whose worker dies never reaches the completed/failed/cancelled notify paths,
  so it stays in `MetaState.active_runs` forever — durably, across CAN.
- **Approach:**
  - **Cancel:** run `run_sandbox` in an `asyncio.Task` and race it against the
    cancel signal (`workflow.wait_condition(lambda: self._cancelled)`); on
    cancel, request activity cancellation (heartbeating activity + a cooperative
    check in the abox driver that issues `abox stop --clean`). Ensure the
    terminal report phase still runs so a `cancelled` result is persisted.
  - **`active_runs` reconciliation:** add a periodic reconcile in
    `MetaAgentWorkflow` (query child run status via the ledger activity, or a
    TTL on entries) that drops runs which are terminal/absent. Belt-and-suspenders
    for the best-effort `_notify_meta`.
- **Files:** `temporal/workflows.py`, `temporal/activities.py`, `abox/runner.py`.
- **Tests:** cancel test asserting a running-sandbox cancel produces a
  `cancelled` run with the sandbox torn down; reconcile test asserting a leaked
  entry is cleaned within one cycle.
- **Effort:** M.

### 2.4 Unify the eval assembly (Weakness #10 / parity) — M
- **Problem:** three different eval assemblies produce different scorecards for
  the same run: Temporal `_impl.run_eval_suite` appends `critic_eval`;
  `pipeline.run_objective` runs `run_suite` only; `MetaAgentTools.run_eval_suite`
  uses `run_default_suite` (no critic, no perf/simplicity). Promotion decisions
  can disagree by path, despite `pipeline.py` claiming "identical" behavior.
  Canary graduation also only happens on the Temporal path.
- **Approach:** extract a single `assemble_eval_suite(ctx, *, with_critic: bool,
  role: str)` used by all three entry points, with the critic toggle driven by
  explicit configuration (e.g. a `critic` flag on the eval context / policy)
  rather than by which code path you're on. Make the in-process pipeline call
  the same assembler; if the critic requires a live model, gate it behind
  availability and record its absence in the scorecard rather than silently
  omitting it. Correct the `pipeline.py` docstring to state the real parity
  contract. Consider moving canary graduation into the shared post-run step so
  the offline path can exercise it too (or explicitly document it as
  Temporal-only).
- **Files:** `evals/__init__.py`/`evals/checks.py` (assembler), `temporal/_impl.py`,
  `control/pipeline.py`, `control/tools.py`.
- **Tests:** parity test asserting all three entry points produce the same suite
  set for the same objective/config; update existing eval tests.
- **Effort:** M.

### 2.5 Dead-letter malformed specs in `AgentRunWorkflow` (Weakness #5 from orchestration review) — S
- **Problem:** `AgentRunWorkflow.run` catches only `ActivityError`/
  `ChildWorkflowError`. A `KeyError` from a malformed spec
  (`bundle["agent_spec"]["metadata"]["name"]`) is uncaught → the workflow task
  fails and retries indefinitely instead of dead-lettering.
- **Approach:** validate the bundle/spec shape up front (pydantic
  `AgentSpec.model_validate`) and, on failure, transition the run to `failed`
  with a `bundle_incompatible`/`malformed_spec` reason and notify meta —
  matching the existing dead-letter posture in `MetaAgentWorkflow` for
  unresolvable specs. Catch the narrow validation error, not bare `Exception`.
- **Files:** `temporal/workflows.py`.
- **Tests:** malformed-spec run dead-letters (single failed record, no infinite
  retry).
- **Effort:** S.

### 2.6 Canary graduation concurrency guard (Weakness #6 from orchestration review) — S
- **Problem:** `check_canary_graduation` reads window stats and issues status
  transitions with no locking; two runs finishing near-simultaneously can both
  observe the canary and both attempt graduate/archive.
- **Approach:** guard the read-decide-write with a Postgres advisory lock keyed
  by `(agent_name)` (reuse the outbox drainer's advisory-lock pattern), or make
  the graduating `set_version_status` a guarded conditional update
  (`WHERE status='canary'`) so the second writer is a no-op. Prefer the guarded
  update — cheaper and idempotent.
- **Files:** `temporal/_impl.py`, `registry/postgres_ledger.py`.
- **Tests:** live test with two concurrent graduations → exactly one transition.
- **Effort:** S.

---

## Phase 3 — Sandbox enforcement honesty + defence-in-depth

The security posture is sound (abox is the real boundary) but the code and
docs overstate in-process enforcement. Make the claims true or correct them.

### 3.1 Decide and close the `SandboxProfile`/`PROFILES` gap (Weakness #1) — M
- **Problem:** `PROFILES` is defined, exported, and **never consumed** by
  `build_command`. Per-profile `allowed_commands`, `max_changed_files`,
  `network_bundles`, `can_merge`, `ephemeral` have no runtime effect, yet
  `docs/security.md` states restrictions "are enforced by the abox sandbox
  profile (`abox/runner.py::PROFILES`)." `maxChangedFiles` is only checked
  post-hoc in evals — after the code already ran.
- **Decision required** (recommend the hybrid): abox owns the *hard* boundary
  (network, filesystem, command execution); some profile dimensions are
  meaningfully enforceable host-side pre/post-run, others are abox-config that
  bakudo should *pass through*, not re-implement.
- **Approach (hybrid):**
  - Wire the dimensions bakudo can honestly enforce: map the spec's
    `sandbox.profile` → a `SandboxProfile`, and pass `network_bundles` / network
    mode and `--timeout` through to the real `abox run` invocation so they take
    effect (today `networkBundles` are deliberately repo-owned in
    `.abox/project.toml`; document that clearly and make the run-level narrowing
    explicit).
  - Enforce `max_changed_files` / `can_merge` as **pre-collection host-side
    gates** in the collect-artifacts step (reject/flag a diff that exceeds the
    limit before it can be surfaced as a candidate), not only in evals.
  - For dimensions that are purely abox-config (filesystem, allowed commands),
    **stop claiming code-side enforcement**: correct `docs/security.md` to say
    they are enforced by the abox project profile the operator provisions
    (already a `HUMAN_TASKS.md` step), and have the runner **assert** the named
    profile exists / matches when it can.
  - If a dimension can be neither enforced nor honestly passed through, delete
    it from `SandboxProfile` rather than leave dead config.
- **Files:** `abox/runner.py`, `control/pipeline.py`/`temporal/_impl.py`
  (collect step), `docs/security.md`, `docs/HUMAN_TASKS.md`.
- **Tests:** a diff exceeding `max_changed_files` is rejected pre-candidate;
  network mode/bundles reach `build_command`; doc assertions in a security test.
- **Effort:** M.

### 3.2 Assert abox is actually abox (Weakness #3) — S
- **Problem:** the default executor is a plain host `subprocess`; the only thing
  making a run a microVM is that `argv[0]` resolves to `abox`. A *wrong*
  `abox_bin` silently becomes a hostile-code host subprocess (a missing one
  errors cleanly).
- **Approach:** on runner startup (once per process), run `abox --version`,
  assert it matches the supported range (the code already targets 0.6.0), and
  fail closed on mismatch/absence. Cache the check. This turns a silent
  security downgrade into a loud boot error, consistent with the existing
  fail-closed sandbox-selection posture.
- **Files:** `abox/runner.py`, `temporal/_impl.py` (sandbox resolver),
  `temporal/worker.py` (posture log).
- **Tests:** wrong/absent binary → `AboxNotFoundError`/version error, no
  subprocess of a task; correct binary passes.
- **Effort:** S.

### 3.3 Harden the in-process command policy's obvious holes (Weakness #2) — S
- **Problem:** `CommandPolicy` is a lowercased substring denylist + `argv[0]`
  basename allowlist — trivially bypassable (`python -c "import urllib…"`,
  `git -c core.pager=…`, `$(...)`, tab separators). It is **correctly labeled**
  defence-in-depth, so this is hardening, not a boundary fix.
- **Approach:** close the cheap holes without pretending it's a sandbox:
  reject inline-code flags on interpreters already in the allowlist
  (`python -c`, `python -m` for non-allowlisted modules, `node -e`, `bash -c`,
  `sh -c`), reject command-substitution/backtick/pipe-to-shell metacharacters,
  and match on the resolved argv (post-`shlex`) rather than raw substrings.
  Keep the framing in `docs/security.md`: this stops naive attempts; abox is the
  boundary. Do **not** expand scope into trying to make it a real jail.
- **Files:** `strands_tools/policy.py`, `tests/test_policy.py`.
- **Tests:** the listed bypasses are denied; legitimate `python -m pytest` /
  `git diff` still pass.
- **Effort:** S.

### 3.4 `Workspace.resolve` symlink write edge case (Weakness B, minor) — S
- **Problem:** `Workspace` confines I/O to the worktree root by `resolve()`
  + parent check, but a pre-existing symlink whose resolved target stays under
  root could still be written through; it is the *only* FS confinement in the
  in-process `local` sandbox.
- **Approach:** on write, reject when any path component is a symlink (or
  `O_NOFOLLOW`-style open), and re-check the final resolved target is under root
  *after* opening. Low severity given abox is the real boundary in prod, but the
  `local` dev sandbox deserves it.
- **Files:** `strands_tools/workspace.py`, `tests/` (new symlink-escape test).
- **Effort:** S.

---

## Sequencing summary

| Phase | Theme | Items | Rough effort |
|---|---|---|---|
| 0 | Trivially safe honesty/nits | 0.1–0.3 | ~1 day, one PR |
| 1 | Postgres/graph correctness | 1.1–1.6 | ~1–1.5 weeks |
| 2 | Governance that governs | 2.1–2.6 | ~1.5–2 weeks |
| 3 | Sandbox enforcement honesty | 3.1–3.4 | ~3–4 days |

Recommended order is Phase 0 → 1 → 2 → 3. Rationale: Phase 0 is free signal;
Phase 1 makes the durable substrate sound before Phase 2 builds governance on
top of it (2.1 concurrency depends on 2.3's accurate `active_runs`, which
depends on a correct ledger); Phase 3 is mostly doc-truth + cheap hardening and
can run in parallel with 1–2 by a second contributor since it touches disjoint
files (`abox/`, `strands_tools/`, `docs/security.md`).

### Cross-cutting acceptance
- Every PR keeps `make check` green (ruff + mypy + pytest) and adds tests that
  fail before the fix.
- Live-path items (1.x, 2.6) additionally pass the opt-in live suites against a
  real Postgres/FalkorDB before the finding is ticked.
- Each item that touches a doc claim updates `docs/security.md` /
  `docs/operations.md` / `docs/HUMAN_TASKS.md` in the same PR so code and docs
  never drift again.

### Open decisions for the maintainer
1. **3.1**: enforce-vs-passthrough-vs-delete per `SandboxProfile` dimension —
   the plan recommends the hybrid but the exact split is a judgment call.
2. **2.1**: budget accounting unit (tokens rolled to USD via a price map vs. a
   simpler per-run count) and whether the ceiling is hard-block or advisory.
3. **1.1**: connection-per-call vs. a pool (`psycopg-pool` dependency).
4. **2.4**: whether canary graduation moves into the shared post-run step
   (offline-exercisable) or stays explicitly Temporal-only.
