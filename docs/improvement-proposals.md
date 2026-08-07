# Improvement proposals for bakudo

A review of bakudo against three contemporary agent systems —
[prime-agent](https://github.com/PrimeIntellect-ai/prime-agent) (PrimeIntellect's
self-improving RLM coding agent), [pi](https://github.com/earendil-works/pi)
(the minimal terminal coding harness bakudo's peers fork from), and
[cas](https://github.com/codingagentsystem/cas) (a Rust control plane for
driving off-the-shelf coding CLIs) — plus a deep survey of bakudo itself.

The short version: bakudo's *design* (versioned agents, evaluate every run,
promote only measured improvements, microVM isolation) is a genuine
differentiator none of the three reference projects has. The gap is between
the design and the code: several advertised subsystems are unreachable, the
run pipeline exists twice, key eval gates cannot fail, and the eval corpus
references fixtures that don't exist. The highest-leverage work is closing
those gaps, and the reference repos supply proven patterns for exactly the
pieces that are weakest — deterministic testing of the agent loop, honest
benchmarking, and enforcement-not-advice quality gates.

Findings are grouped as: correctness fixes (§1), simplification (§2),
performance (§3), UX/operability (§4), patterns worth adopting (§5), and a
concrete eval/benchmark suite proposal (§6). File references are to this repo
unless prefixed with a project name.

---

## 1. Correctness first: make the advertised system actually run

These are bugs, not opinions. Until they're fixed, the README describes a
system that does not exist in production mode.

1. **Blocking work on the Temporal event loop.** Every activity in
   `src/bakudo/temporal/activities.py` is `async def` but immediately calls a
   synchronous `_impl.*` function — including `run_sandbox`, which is a
   blocking `subprocess.run` on a microVM with a 2-hour timeout. In the
   Temporal Python SDK, async activities run *on the worker's event loop*, so
   one agent run blocks every other workflow task, heartbeat, and query on
   that worker. Declare them `def` (sync) so the SDK dispatches to the
   executor, or wrap in `asyncio.to_thread`. Add activity **heartbeats** with
   a `heartbeat_timeout` — today a crashed worker mid-run is undetected for
   up to 2 hours, and the retry policy then re-runs the whole sandbox.

2. **`MetaAgentWorkflow` crashes on first dispatch.**
   `temporal/workflows.py:387` reads `objective["agent_spec"]`, a key nothing
   ever sets. There is also no agent-selection logic (the curriculum's
   `suggested_agents` is read by nobody), and `AgentRunWorkflow` never signals
   `run_completed` back to the parent, so `active_runs` grows forever.

3. **Three workflows are defined but never registered.**
   `AgentEvolutionWorkflow`, `MemoryCompactionWorkflow`, and
   `RepoObserverWorkflow` are missing from `temporal/worker.py` — meaning
   agent evolution, memory compaction, and the curriculum observer (the three
   pillars the README advertises) never run in production.

4. **The fail-closed sandbox guarantee is bypassed on the CLI/API path.**
   `_impl.Deps.sandbox_fn()` carefully refuses to guess a sandbox, but
   `control/pipeline.py:48` does `sandbox = sandbox or local_sandbox` — and
   every API route and CLI command goes through `run_objective`. A deployed
   API `POST /runs` executes untrusted work in-process. The default should be
   fail-closed everywhere; `local_sandbox` should require explicit opt-in
   (e.g. `BAKUDO_SANDBOX=local` plus a non-production env check).

5. **`schema_eval` can never fail.** `ctx.schema_valid` is `True` at every
   call site, yet `schema` is one of two required and critical suites — half
   the promotion safety gate is a no-op. Actually validate `result.json`
   against `schemas/run-result.schema.json` in the eval path.

6. **The memory read path is dead.** Writes flow through policy → pgvector →
   Neo4j, but `TaskBundle.memory_excerpts` is never populated by any caller,
   so `query-memory` always returns `[]`. Either wire retrieval into bundle
   rendering (query the semantic store with the objective title/description
   at `render_bundle` time) or cut the memory subsystem until it's consumed —
   write-only memory is pure carrying cost.

7. **Promotion can never complete.** `PromotionPolicy.decide()` terminates at
   `canary`; nothing ever advances a canary to `promote`, and
   `canary_percent`/`canary_min_runs` are inert. Either implement the canary
   observation loop or collapse the policy to a single promote decision and
   delete the canary fields until they're real.

8. **`load_role_spec` breaks in an installed wheel.** `optimize.py:161`
   resolves `agents/` relative to the source tree; `paths.py` already solves
   this for `schemas/` and `skills/` — do the same for `agents/`.

---

## 2. Simplify: one pipeline, less dead weight, honest scope

### 2.1 Collapse the duplicated run pipeline

The single most expensive structural problem: the run pipeline and the
optimize loop each exist twice (sync in `control/`, durable in `temporal/`),
with three divergent `EvalContext` constructions — one of which
(`control/tools.py:138`) builds an empty context so safety and cost gates
silently pass.

pi's harness-v2 design doc (`packages/agent/docs/harness-v2.md`) is the
reference here: route **every side effect through one injected seam**, and
make both drivers (sync and Temporal) thin shells over the same core.
Concretely:

- Extract a single `run_pipeline_core(deps, objective, spec) -> RunOutcome`
  covering bundle → sandbox → normalize → eval-context → suite → scorecard →
  ledger. `control/pipeline.py` calls it directly; each Temporal activity
  calls one phase of it. One `EvalContext` constructor, used everywhere.
- Replace the `DEPS = Deps()` process-global (`temporal/_impl.py:83`) with
  explicit dependency injection. The global plus `getattr`-based duck typing
  (`hasattr(ledger, "create_run")`, `getattr(..., "record_eval", None)`)
  defeats the `Ledger` Protocol and currently hides a real bug —
  `PostgresLedger` has no `promotions()`, so `/promotions/pending` silently
  returns `[]` in production. Trust the Protocol; add the missing methods.
- Same for the optimize loop: `run_optimize_loop` and `OptimizationWorkflow`
  should share one round/gate driver, not ~60 duplicated lines each.

This one refactor closes the sandbox-default hole (§1.4), the divergent eval
contexts, and the dropped-observability gap (the workflow path currently
discards `outcome.observability`) in a single move.

### 2.2 Delete or de-scope dead weight — and say so in the README

pi's README is the model: every deliberately-missing feature gets one line of
rationale and an escape hatch. bakudo should do the same instead of carrying
decorative surface area:

- **`AgentSpec.mcpServers`** has zero runtime wiring. Either wire it or mark
  it reserved in the schema and remove the model field.
- **`sandbox.maxChangedFiles` / `maxDiffBytes` / `canMerge`** are never
  enforced. Enforce them in result normalization (fail the run when the diff
  exceeds budget — this is a cheap, high-value safety gate) or remove them.
- Dead code inventory to delete: `abox/runner.py` `PROFILES` (34 lines, 0
  callers), `memory/graph.py`'s three unused query methods,
  `Ledger.active_version`/`get_agent_version`, seven `MetaAgentTools`
  methods with test-only callers, `TaskBundle.eval_rubric`, and the 8 of 14
  Postgres tables nothing reads or writes (or keep the DDL and add a comment
  that they're forward-looking — but today they read as drift).
- Doc drift: `.github/workflows/ci.yml` and `docs/operations.md` both still
  instruct a `git mv` from `ci/` that already happened;
  `docs/HUMAN_TASKS.md` claims workflows are done that are unregistered dead
  code. Stale instructions in an operator checklist are worse than none.

### 2.3 Central, validated configuration

Environment variables are read at 11 different sites with no validation, and
`_resolve_base_url` silently falls back to `https://vllm-gateway.internal/v1`
— a run against a nonexistent host instead of a startup error. Two patterns
to combine:

- A single `BakudoSettings` (pydantic-settings) object: every env var
  declared once, typed, validated at startup, injected everywhere. prime-agent's
  rule applies: **model/endpoint selection fails loudly** — if no base URL is
  configured, refuse to start the worker rather than default to a phantom
  host. Same for `BAKUDO_OFFLINE=1`, which today silently converts every run
  into a hardcoded `blocked` result.
- cas's **config metadata registry**: one declaration (`key, description,
  section, type, default, constraint`) powering `bakudo config list`,
  `bakudo config describe <key>`, validation, and docs generation. This is
  cheap on top of pydantic-settings (the field metadata is already there) and
  eliminates the docs/env-var drift class entirely.

### 2.4 Four status enums → documented state machines

`RunStatus`, `RunPhase`, `ObjectiveStatus`, `SpecStatus` overlap with no
conversion helpers. Keep them (they model different things) but add explicit
transition functions with tests, cas-style: a truth table per transition,
tested exhaustively. It's ~50 lines and removes a whole class of "which enum
is this string" bugs.

---

## 3. Performance

1. **Sync activities + heartbeats** (§1.1) — the dominant fix; everything
   else is second-order until the worker can actually run concurrent
   activities.
2. **Bound the sandbox fan-out.** When `OptimizationWorkflow` fans out
   attempt runs (and future corpus runs fan out 25+ sandboxes), microVM boots
   will collapse without admission control. prime-agent's
   `boot-gate.ts` is the reference: an empirically-tuned semaphore
   (`cores*2`-ish, lazily resolved, env-overridable but clamped) plus a
   `boot-bench` script that measures boot success rate and p50/p95 latency at
   N concurrent boots. Add `scripts/sandbox-bench.py` and tune abox
   concurrency from measurement, not vibes.
3. **Cut redundant serialization.** `render_bundle` round-trips the full
   bundle through Temporal's payload converter, re-validates it in
   `run_sandbox`, and `AboxRunner._write_bundle` then writes it to disk three
   times (`agent.yaml` + `objective.json` are redundant with `bundle.json`,
   which is what `--bundle` actually consumes). Write once. Also consider
   batching the 7+ per-run `persist_run` phase updates — each is a full
   activity round-trip for a single `UPDATE`.
4. **Postgres memory store:** add the pgvector HNSW index (currently every
   `<=>` is a sequential scan), an expression index for the
   `lower(trim(content))` dedup predicate, a `LIMIT` on
   `PgSemanticMemoryStore.all()`, and fix `query()` applying
   `min_similarity` *after* `LIMIT` (it silently returns fewer results than
   asked — over-fetch then filter).
5. **`RepoObserverWorkflow` polling:** dedup emitted objectives across cycles
   (persist a seen-set keyed by `(type, title)`), and skip collection when
   the repo state hash is unchanged — the same snapshot-hash memoization
   trick as §5.1.
6. **`_extract_json_blob`** (`runner/result.py:76`) runs a greedy
   `re.search(r"\{.*\}", ..., re.DOTALL)` over arbitrary model output —
   quadratic on large outputs. Scan for the first balanced JSON object
   instead, or require a fenced block.

---

## 4. User-friendliness and operability

1. **Make the CLI the operator surface it claims to be.** Today it has 5
   subcommands and no way to submit an objective, list runs, inspect a
   scorecard, run a corpus, or drive evolution. Target surface:

   ```
   bakudo objective submit|list
   bakudo run <objective-id> [--agent NAME] / bakudo runs [--status ...]
   bakudo scorecard <run-id>
   bakudo eval corpus <path> [--agent NAME] [--baseline VERSION]
   bakudo evolve <agent> [--dry-run]
   bakudo promote <candidate> / bakudo promotions
   bakudo config list|describe <key>
   bakudo doctor        # checks Temporal/Postgres/Neo4j/vLLM/abox reachability
   ```

   `bakudo doctor` (cas has one) is the highest-value single addition: with
   five infra dependencies, "which one is misconfigured" is the first
   question every operator hits.

2. **Fix the demo.** `bakudo demo` forces offline mode and prints a hardcoded
   `blocked` result with score ~0.5 — it demonstrates plumbing, not the
   product. With a scriptable fake driver (§6.2) the demo can show a real
   scorecard, a real promotion decision, and a real no-change outcome, still
   fully offline.

3. **Async job pattern for the API.** `POST /optimize` and `POST /runs` run
   synchronously inside the request handler — a multi-round optimize with
   real models holds an HTTP connection for hours. Return `202 Accepted` +
   run id, poll `GET /runs/{id}` (which already exists). This also finally
   connects the API to the durable plane: the handlers should start Temporal
   workflows via `temporal/client.py` (currently 100% dead code) instead of
   driving the in-process `MetaAgentTools`.

4. **Structured logging with correlation IDs.** No logging module is imported
   anywhere in `src/` — output is `print()`. `ids.py`'s whole docstring is
   about correlation ids; actually emit them. One `structlog` (or stdlib
   `logging` + JSON formatter) setup, `run_id`/`objective_id` bound at
   pipeline entry. Skip the full OTEL stack for now — see §5.6 for the
   cheaper substrate.

5. **Ship the compose file that runs.** The worker container sets
   `BAKUDO_SANDBOX=abox` but abox is neither in the image nor the compose
   file, so the first real run fails; Neo4j has no healthcheck and the worker
   doesn't depend on it. Make `docker compose up` → `bakudo demo` (online
   mode, against LiteLLM) a tested path — this is the first hour of every new
   user's experience.

---

## 5. Patterns worth adopting from the reference repos

Ranked by leverage-per-effort for bakudo specifically.

1. **Gate memoization via workspace snapshot hash** (prime-agent
   `autonomous.ts:284-348`). Before re-running a failed gate/benchmark, hash
   `git status --porcelain -z -uall` + diff + untracked files. If identical
   to the last failure, don't re-run — advance the attempt counter and tell
   the model "the workspace has not changed since this failure." Apply to:
   bench command re-runs in the optimize loop, eval re-runs on retry, and the
   repo observer (§3.5). Turns expensive verifiers into O(1) no-ops when an
   agent is spinning.

2. **Enforce gates as capability jails, not prompt requests** (cas
   `pre_tool.rs` + `authorize_agent_action()`). bakudo already has the right
   substrate — policy-enforced worker tools — but the output contract is
   advisory. When a run's diff exceeds `maxDiffBytes`/`maxChangedFiles`, or a
   required artifact is missing, deny further mutating tools and allow only
   "fix the contract violation" actions. Enforce at two layers (tool builder
   *and* result normalization) the way cas does hook + server.

3. **Four-budget stop policy** (prime-agent `DEFAULT_AUTONOMOUS_LIMITS`):
   independent caps on continuations, turns, tokens, and wall time, checked
   in order — and token accounting **excludes cache reads** (counting them
   exhausts budgets long before real work does). bakudo's `cost_eval`
   currently grades against hardcoded defaults instead of `bundle.budget`;
   fix that and adopt the cache-read exclusion in `_capture_usage` (which
   also must stop swallowing all exceptions — silent zero tokens makes
   `cost_eval` silently pass).

4. **Cheap classifier gates expensive judge** (prime-agent
   `reviewAutoRefine`): a small-budget model call decides *whether* the
   32k-budget refinement/judge call runs at all. Use this to make
   `critic_eval` affordable enough to put in the default suite (§6.4). Two
   related prompt-engineering facts from their code: disable extended
   thinking on structured-output calls (reasoning burns the output budget and
   returns no JSON), and scale output budgets with the model rather than
   using constants.

5. **Plan/apply split with baseline conflict rejection + first-class
   rollback** (prime-agent `refinement.ts`). bakudo's evolution flow should
   record before/after snapshots of the spec mutation so promotion has an
   inverse (`rollback <version>`), and re-read shared state immediately
   before applying an LLM-planned mutation. The append-only
   `refinements.jsonl` history maps directly onto bakudo's ledger.

6. **Run-record JSONL as the analytics substrate** (prime-agent, pi). Instead
   of building a metrics pipeline, ensure everything about a run (usage,
   cost, phases, denials, eval results) lands in one append-only record, then
   ship small mining scripts (`scripts/run-stats.py`, `scripts/cost.py`)
   that answer "what did last week cost, which agent fails most, which tool
   errors dominate." bakudo's ledger events are already close; the missing
   piece is *reading* them (`Ledger.eval_results()` has zero callers).

7. **Harness capability matrix → policy matrix with truth-table tests** (cas
   `harness.rs` + `harness_policy.rs`). As bakudo grows beyond one model
   provider and one sandbox type, derive feature gates (can this agent
   self-verify? does this sandbox support network bundles?) from a declared
   capability struct, with a unit test per matrix cell — not scattered
   `if provider == ...` checks.

8. **Fire-and-forget subagents** (prime-agent `rlm()`): child runs return a
   handle at admission, never the result; results arrive via messages or
   artifacts. If/when the meta-agent dispatches concurrent runs, this shape
   (which Temporal child workflows + signals naturally support — once
   `run_completed` is actually wired, §1.2) structurally prevents the
   parent-blocks-on-child antipattern.

9. **Session/run archaeology as UX** (pi `/tree`, `/export`; cas
   `.rec` recordings): a `bakudo export <run-id>` producing a
   self-contained HTML report (bundle, transcript, diff, scorecard) is the
   "share a run" primitive that makes eval failures debuggable by humans.

---

## 6. Eval / benchmark suite proposal

This is the area where the reference repos are most instructive by contrast:
prime-agent keeps scoring *out* of the repo (external verifiers), cas has a
per-task LLM judge but no run-level scoring, and pi has the best-designed
eval package of the three. bakudo's pitch is "every run is evaluated" — so
its eval suite should be its crown jewel, and today it has: two eval levels
that can't fail (§1.5, cost with wrong budgets), two spec'd levels missing
(sandbox, regression), a critic that's wired into nothing, corpora for 3 of
10 agent roles, a 25-case optimize corpus pointing at a fixture repo that
doesn't exist, and zero eval execution in CI.

Proposed build-out, in order:

### 6.1 Make the graders honest (prerequisite for everything else)

- **Harness-measured benchmarks.** `perf_eval` currently grades
  `bench_seconds_before/after` that the *agent itself reports* — the
  optimize-attempt prompt just asks the model for the numbers. The harness
  must run `constraints.benchCommand` itself, in the sandbox, before and
  after the change (N≥3 runs, median, the existing 2% noise floor), and
  write the measurements into `EvalContext`. Same for `complexity_*` (run
  `radon`/`lizard` in-harness). Until this lands, the optimize loop's win
  condition is "the model claims it got faster."
- Fix `schema_eval` (§1.5), make `cost_eval` read `bundle.budget`, and
  separate score from pass in `_delta_eval` (a 60% and a 200% improvement
  should not both score 1.0 — log-scale the improvement).
- Implement the two missing spec'd levels: **sandbox eval** (did the run
  respect file/diff budgets, network policy, denied-command count — the data
  is already in `RunResult`) and **regression eval** (§6.3).

### 6.2 A deterministic offline harness (pi's faux provider, ported)

pi's single best testing idea: a **scriptable fake provider** that lets ~60
regression tests drive the real agent loop with zero API cost, mandated by
their AGENTS.md. bakudo's equivalent is a **scriptable fake sandbox driver**:

```python
driver = FauxDriver([
    FauxRun(status="success", diff=..., tests_passed=12, tests_failed=0,
            metrics={"bench_seconds_before": 2.0, "bench_seconds_after": 1.4}),
    FauxRun(status="blocked", blocked_reason="..."),
])
```

replacing today's `_default_offline_driver` (which returns one hardcoded
`blocked` result, making the CI "smoke" assert nothing). With it:

- The full pipeline — bundle → result → eval suite → scorecard → promotion
  decision — becomes deterministically testable end-to-end, including the
  Temporal workflows under `temporalio.testing.WorkflowEnvironment` (currently
  the 434-line `workflows.py` has zero tests; §1.2's bugs would have been
  caught by the first such test).
- Adopt pi's convention: issue-specific regressions in
  `tests/regressions/<issue>-<slug>.py`, run on every PR.
- `bakudo demo` becomes a real demo (§4.2).

### 6.3 Regression tracking: persist, compare, gate

The `eval_results` table is written and never read. Close the loop:

- Persist a **scorecard per (agent version, corpus, commit)** — the
  `eval_suites`/`eval_cases` tables in the DDL are already shaped for this.
- **Regression eval level**: every case an agent version has ever failed
  joins that agent's permanent regression set; a candidate must pass its
  predecessor's regression set before promotion. Restore `regression` to
  `PromotionPolicy.required_suites` (the current defaults deliberately drop
  it, so a candidate can be promoted without ever seeing a regression
  corpus).
- **CI gating**: every PR runs the offline deterministic corpus and compares
  the scorecard against the base branch's stored scorecard; a drop fails the
  check. cas's build-time-regression gate (`check-build-regression.sh`,
  fail if >25% over baseline) is the exact shape — applied to eval scores
  instead of compile times.

### 6.4 Fix the corpora

- **Build the missing fixture.** `evals/corpora/optimize.yaml` (25 cases,
  616 lines) references a `payments-api` fixture repo that does not exist —
  the corpus is currently unexecutable. Create
  `evals/fixtures/payments-api/` as a small synthetic repo with the 20
  planted inefficiencies and pytest benchmarks the cases describe, pinned by
  a lockfile so measurements are stable.
- **Grow role coverage.** Corpora exist for 2 of 10 agent roles. Priority
  order: `qa` and `critic` next (they gate other agents' outputs), then
  `explore`. `add-feature.yaml` needs to grow from 2 cases toward the
  25-case promotion bar its own policy requires.
- **Keep the decoy pattern.** The 5 no-change decoys (`maxChangedFiles: 0`)
  are one of bakudo's best ideas — every new corpus should include cases
  where the correct answer is "don't touch it."

### 6.5 Wire the critic, gated

`critic_eval` and `llm_judge` exist and are called by nothing. Adopt the
cas + prime-agent combination:

- **Rubric with receipts** (cas `task-verifier.md`, the best judge rubric of
  the three repos): check the agent's own summary for self-admitted
  incompleteness *first*; require every finding to cite command output
  ("comments come with receipts"); flag new-symbol-with-zero-references as
  blocking; detect missing co-changes (impl without test); split blocking
  vs. warning findings; document what each confidence score means.
- **Gate it** with a cheap classifier call (§5.4) so it can afford to be in
  `DEFAULT_SUITE` — most runs get a 1-call triage, only ambiguous ones get
  the full judge.
- Judges run with thinking disabled and a strict JSON contract (§5.4).

### 6.6 A/B agent-version comparison (pi-evals, ported)

pi's `evalHarnessTable` is precisely the missing measurement layer for
bakudo's promotion story: run baseline and candidate agent versions over the
same corpus with R repetitions, report **pass-rate lift in percentage
points** plus paired per-case deltas for tokens, latency, and cost, and
surface missing/duplicate observations as typed diagnostics instead of
silently dropping them. Two of their methodology rules to keep:

- In comparative runs, a low score is an *observation*, not a test failure —
  hard assertions are reserved for suite invariants.
- Snapshot every run's full session/run record as an artifact *before*
  cleanup, so any surprising delta is debuggable after the fact.

This becomes the engine behind `bakudo evolve` — today `evolve_agent` runs
the corpus twice serially with no repetitions and no paired statistics.
Parallelize corpus cases under the boot-gate semaphore (§3.2) and cache the
baseline scorecard across candidates (currently re-run for every candidate).

### 6.7 External benchmarks: adapters, not core

Follow prime-agent's separation: standard benchmarks (SWE-bench-lite,
terminal-bench) live behind thin adapters in `evals/adapters/`, mapping each
external task to an Objective + fixture checkout and each result to a
scorecard — never as core dependencies. They're for public calibration;
bakudo's own corpora (with decoys and regression sets) remain the promotion
authority.

### 6.8 CI shape

```
per-PR   : lint + type + unit tests
           + deterministic pipeline tests (FauxDriver, Temporal test env)
           + offline corpus run → scorecard diff vs base branch (gate)
nightly  : model-backed corpus run (small N, LiteLLM/vLLM) → scorecard
           persisted to ledger → trend report artifact
weekly   : full optimize-corpus A/B on current vs previous promoted
           agent versions; external benchmark adapters (optional)
```

Plus cas's discipline of treating one non-functional metric as a tested SLO —
for bakudo the natural first one is **eval-suite wall time per run**, so the
"evaluate every run" promise stays cheap enough to keep.

---

## Suggested sequencing

| Phase | Contents | Why first |
|---|---|---|
| 1. Make it true | §1 fixes (blocking activities, unregistered workflows, meta-agent dispatch, fail-closed sandbox, schema gate, memory read path) | The README's claims should be true before anything is built on them |
| 2. Make it one thing | §2.1 pipeline consolidation, §2.3 config, §2.2 dead-code cut | Every later change costs half as much once the pipeline exists once |
| 3. Make it measurable | §6.1 honest graders, §6.2 FauxDriver + Temporal tests, §6.4 fixture repo, §6.3 regression gating in CI | The eval suite is the product's thesis |
| 4. Make it fast & pleasant | §3 perf, §4 CLI/doctor/API-async/logging, §6.5–6.7 critic, A/B, adapters | Best done against a consolidated, measured core |
