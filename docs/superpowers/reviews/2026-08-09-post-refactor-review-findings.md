# Post-refactor review findings (bb0d640..d78555c, vs abox 0.6.0)

Five parallel in-depth reviews of the meta-redesign merge (PR #25) plus the CI
swap (PR #26), conducted 2026-08-09 on branch `validate/abox-0.6.0-e2e`.
Static review + local test runs only; no live services were mutated.

**Verified-green baseline** (this machine):

- `make check`: ruff clean, mypy clean (62 files), **136/136 tests pass** —
  the old #10 FastAPI-0.137 failure is fixed (by 37c5db6) and gone.
- Offline `bakudo demo` e2e passes: `phase: completed`, score 0.700.
- Live infra all reachable: Temporal `temporal.almckay.io:7233`, Postgres
  `postgres.almckay.io:5432`, Neo4j `neo4j.almckay.io:7687`; vLLM endpoints
  serving `Qwen3.6-35B-A3B-FP8`, `Qwen/Qwen3.5-0.8B`, `Qwen/Qwen3-Embedding-0.6B`.
- Environment footgun: the stale **Rust `bakudo` binary at `~/.cargo/bin/bakudo`
  shadows the new Python CLI** on PATH (`error: unrecognized subcommand 'demo'`).
  Remove/rename it, or invoke `python3 -m bakudo.cli`.

**Bottom line:** the offline/local plane is coherent and well tested. The
production planes have never executed: the abox path is rejected by the real
0.6.0 CLI at argv parse time, the Postgres ledger FK-fails on the first run,
and the eval/promotion gates are fed by self-reported or never-populated
signals. CI is green because the unit tests pin the wrong abox protocol,
`PostgresLedger`/Temporal-environment tests don't exist, and CI silently
skips the API suite.

Severity counts after dedup: **9 blockers, ~30 major, ~30 minor.**

---

## A. abox / worker plane (`abox/`, `runner/`, `strands_tools/`, `bundle.py`)

The production abox path is dead on arrival against abox 0.6.0:

- **ABOX-1 (blocker)** `abox/runner.py:151-163` — `build_command` emits
  `--branch` and `--mount`; neither exists in abox 0.6.0. Verified live:
  `error: unexpected argument '--branch' found`, exit 2. Every
  `BAKUDO_SANDBOX=abox` run fails at argv parse.
- **ABOX-2 (blocker)** `abox/runner.py:158,177,192-200` — bundle/result
  channels are wrong: staging should use `--input-file <host>[:<guest>]`
  (guest path `/abox-meta/inputs/`), not a `--mount` over abox-owned
  `/abox-meta`; results must be collected from the worktree via
  `abox path <task>` (guest writes `/workspace/.agent/result.json`), but
  `_collect_result` reads the host scratch dir where nothing ever writes.
  Every run would return `result=None` even with ABOX-1 fixed.
  (Independently found by OPT-2 and API-5.)
- **ABOX-3 (blocker)** `abox/runner.py:157` — `--template` is passed bakudo
  policy-profile names (`explore-readonly`, …) but 0.6.0 semantics are "VM
  snapshot template"; no such templates exist. Guest profile (`python-glibc`)
  must come from `.abox/project.toml` instead.
- **ABOX-4 (blocker)** repo-wide — no `.abox/project.toml`, no prepare flow,
  no trust: `agent-runner` is not installed in the guest (command-not-found),
  no warm caches, no `[network]` bundles, no `[[host_ports]]` bridge.
- **ABOX-5 (blocker)** `runner/agent.py:35-57` + `runner.py:147-163` — no
  model env wiring: `build_command` passes no `-e` vars, so in-guest base URL
  falls to placeholder `https://vllm-gateway.internal/v1`. No host-port
  gateway bridge exists (needs project config, `network.mode="scoped"`).
- **ABOX-6 (major)** — declared isolation never enforced: `networkMode`/
  `network_bundles` never map to `--network`/project config; spec vocabulary
  incompatible (`none` invalid; bundles `github-api`/`vllm-gateway` don't
  exist — 0.6.0 knows only `npm-public`, `pypi-public`, `cargo-public`).
- **ABOX-7 (major)** — `--repo` never passed; `objective.repo` (bare name) is
  never mapped to a path; sandbox forks whatever the worker's cwd is.
  (Also OPT-11: the corpus's `payments-api` fixture repo doesn't exist.)
- **ABOX-8 (major)** — no lifecycle: `ephemeral` not mapped to `--ephemeral`,
  `abox stop --clean` never called; Temporal retries reuse the same `--task`
  → collision with the existing `agent/<run_id>` branch/worktree.
- **ABOX-9 (major)** `strands_tools/workspace.py:53-59` — `git diff` is blind
  to untracked files: create-only changes report empty diff/changed_files,
  silently defeating `maxChangedFiles` gates and diff-based evals.
- **ABOX-10 (major)** — observability lost: `agent-runner` never writes
  `ctx.observability()`/tokens/runtime into `result.json`, and `AboxRunner`
  never populates `diff`/`denied_commands`/`runtime_seconds`/`tokens_used`
  on `AboxOutcome` → safety eval sees zero denials, cost eval scores 1.0,
  in every production run. (= OPT-1.)
- **ABOX-11 (major)** — `subprocess.run` without timeout (hung abox hangs the
  activity); missing binary raises raw `FileNotFoundError`; exit 2/124/agent
  failure all collapse to `succeeded=False`; stdout/stderr dropped by
  `run_sandbox` → failed runs have zero diagnostics.
- **ABOX-12 (minor)** `tests/test_abox_runner.py` — tests pin the *wrong*
  protocol (`--branch`/`--mount`, fake executor writing into the mount dir),
  institutionalizing ABOX-1/2 with green CI.
- **ABOX-13 (minor)** — `READ_ONLY` policy allowlists `git` wholesale
  (`git apply`/`checkout --`/`clean -f` mutate), so explore's read-only
  contract is unenforced in-guest.
- **ABOX-14 (minor)** — `bundle.json` (incl. full eval rubric + memory
  excerpts) is guest-readable and `cat` is allowed → rubric-gaming risk.
- **ABOX-15 (minor)** — dev `local` sandbox inherits the full host env
  (no scrub) and `repo-safe` allows `python -c` → host secrets readable in
  dev runs.
- **ABOX-16 (minor)** — in-guest deadline == abox `--timeout` exactly; the
  graceful `blocked: budget` result can lose the race to the VM kill. Needs
  headroom.
- **ABOX-17 (minor)** — `PROFILES` and spec `max_changed_files`/
  `max_diff_bytes`/`can_merge` are dead configuration; nothing consults them.
- **ABOX-18 (minor)** `runner/prompts.py:17-18` — skills manifest injects raw
  dependency strings, not `{name, description}`; uninstalled skill →
  `KeyError` mid-run.
- **ABOX-19 (minor)** — strands `@tool` over `functools.partial` (no
  `__name__`/`__doc__`) never exercised by any test; uncaught tool exceptions
  crash `local_sandbox` (only `main.py` wraps `build_and_run`).

## B. Temporal / ledger plane (`temporal/`, `registry/`, `control/pipeline.py`)

- **TMP-1 (blocker)** `temporal/activities.py:39-82` — every activity is
  `async def` calling blocking code (subprocess abox runs, sync psycopg);
  both Workers share one event loop (`worker.py:73`) → one sandbox run (≤2h)
  freezes both task queues. Needs sync activities + `activity_executor`
  ThreadPool (and then a psycopg pool — the single shared conn isn't
  thread-safe). (= MEM-8: also blocks on GitHub httpx calls.)
- **TMP-2 (blocker)** `registry/postgres_ledger.py:98-110` vs
  `infra/postgres/init.sql:44` — `runs.objective_id` FK references
  `objectives`, but nothing ever inserts objectives → first `create_run`
  raises `ForeignKeyViolation`; every `AgentRunWorkflow` dies at step one.
  Zero `PostgresLedger` tests exist.
- **TMP-3 (blocker)** `temporal/workflows.py:387` — meta-agent dispatch does
  `objective["agent_spec"]` but no producer supplies that key (observer
  objectives carry `suggestedAgents`) → `KeyError` → workflow-task failure
  retried forever; the singleton meta-agent wedges. (= MEM-7.)
- **TMP-4 (major)** `temporal/worker.py:58-71` — `AgentEvolutionWorkflow`,
  `MemoryCompactionWorkflow`, `RepoObserverWorkflow` registered on neither
  queue ("workflow type not registered" hangs); `decide_promotion` registered
  but never called.
- **TMP-5 (major)** — nothing ever sends the `run_completed` signal;
  `MetaState.active_runs` grows forever across Continue-As-New.
- **TMP-6 (major)** — children started with default parent-close policy
  (TERMINATE) and never awaited → Continue-As-New at 500 dispatches kills
  all in-flight runs mid-sandbox. Needs `ParentClosePolicy.ABANDON`.
- **TMP-7 (major)** `temporal/client.py:24-29` — `ensure_meta_agent` passes no
  `id_conflict_policy` → second call raises `WorkflowAlreadyStartedError`.
- **TMP-8 (major)** — activity retries double-write the ledger: events appended
  with no idempotency key; `eval_results` get fresh UUIDs per attempt;
  `autocommit=True` splits run mutation from its event append. Needs
  idempotency keys or single-transaction writes.
- **TMP-9 (major)** — backend parity: `PostgresLedger.set_phase` never sets
  `started_at` (NULL forever); `finish_run` discards `result` from the run
  row; `InMemoryLedger` does both.
- **TMP-10 (major)** `workflows.py:96-140` — no try/except around activities;
  retry exhaustion leaves the ledger stuck at `agent_running` forever with
  no terminal event.
- **TMP-11 (major)** `workflows.py:214-223` — `asyncio.gather` without
  `return_exceptions=True`: one crashed attempt fails the whole
  `OptimizationWorkflow` and terminates siblings. (= OPT-9.)
- **TMP-12 (major)** — `run_sandbox`: 2h start-to-close, no heartbeat,
  `maximum_attempts=3`: crashes undetected for up to 2h; retries re-execute
  non-idempotent runs onto the same deterministic branch.
- **TMP-13 (major)** `infra/docker-compose.yml:81` — worker container sets
  `BAKUDO_SANDBOX=abox` but the image contains no abox binary; the composed
  stack cannot run a single sandbox.
- **TMP-14 (minor)** — `persist_run` catches only `KeyError` (an
  InMemoryLedger-ism); Postgres manifests the race differently.
- **TMP-15 (minor)** — `cancel` signal checked once, pre-sandbox; a cancel
  during the 2h sandbox phase is ignored.
- **TMP-16 (minor)** — Continue-As-New only on dispatches; a paused/observe
  meta-agent grows history unboundedly.
- **TMP-17 (minor)** `workflows.py:135` — `schema_valid=True` hard-coded into
  `EvalInput`.
- **TMP-18 (minor)** — `_SHORT` (30s) applied to `collect_signals` and
  `compact_memories`, both plausibly slower.

## C. Memory / curriculum plane (`memory/`, `curriculum/`)

- **MEM-1 (blocker)** `memory/embeddings.py:25` + `temporal/worker.py:51` —
  no production embedder exists or is wired; the only implementation is the
  256-dim lexical `HashingEmbedder`. The live embeddings endpoint is
  unreachable from any code path; "semantic" recall is lexical-overlap only.
- **MEM-2 (major)** `store_pg.py:195-222` — `_insert`/`_supersede` are
  non-transactional on autocommit: item/embedding can split (zombie rows that
  block re-writes), and `_supersede` failing after its delete destroys the
  old memory. Real data loss.
- **MEM-3 (major)** — Neo4j mirror runs post-commit with no retry/outbox;
  on mirror failure + Temporal retry, the item is rejected as a repeat and is
  permanently absent from the graph; remaining candidates unprocessed.
- **MEM-4 (major)** — `memory_embeddings.embedding` is untyped `vector`, no
  dimension guard: an embedder swap leaves mixed-dim rows and every query and
  write fails (`different vector dimensions`); untyped column can't carry an
  HNSW index either.
- **MEM-5 (major)** — TTL is write-only: nothing filters or purges expired
  rows; `_item_from_row` drops `ttl` on read.
- **MEM-6 (major)** `curriculum/observe.py:136-153` + `workflows.py:293,424` —
  no cross-cycle idempotency: the same TODO yields a fresh objective (fresh
  id) every 15-minute observer cycle, each dispatched with sandbox+model
  cost, unboundedly.
- **MEM-7 (major)** — = TMP-3 (`KeyError: 'agent_spec'` on observer-fed
  objectives).
- **MEM-8 (major)** — = TMP-1 (blocking calls incl. 30s GitHub httpx inside
  async activities).
- **MEM-9 (major)** `tests/test_store_pg.py` — Pg tests run against a
  `FakeConn` dispatching on SQL substrings; real SQL/Cypher never validated;
  `Neo4jGraphMemory` (incl. three methods with zero callers) untested.
- **MEM-10 (minor)** — supersede never removes the mirrored Neo4j node →
  graph accumulates dead memories Postgres deleted.
- **MEM-11 (minor)** — exact-repeat check is cross-scope: a fact recorded for
  repo A blocks the identical fact for repo B, which scope-filtered recall
  will never return.
- **MEM-12 (minor)** — `min_similarity` applied client-side after `limit`
  (under-returns).
- **MEM-13 (minor)** — `vector_literal` uses `repr(v)`: numpy scalars break
  every insert/query the moment a real embedder returns them.
- **MEM-14 (minor)** — no per-collector error isolation: one GitHub 403
  aborts the whole signal snapshot.
- **MEM-15 (minor)** — `[a-z0-9]+` tokenizer: non-ASCII content embeds to the
  zero vector → NaN cosine → invisible to recall, never dedupes.
- **MEM-16 (minor)** — `init.cypher` vector-index template hardcodes 1536
  dims (Qwen embed = 1024, wired default = 256); graph writes carry no
  `group_id` namespace on the shared live Neo4j.

## D. Evals / optimize plane (`evals/`, `control/optimize.py`, `control/tools.py`)

- **OPT-1 (blocker)** — = ABOX-10: production scorecards are graded on empty
  signals; the safety gate is vacuous exactly where it matters.
- **OPT-2 (blocker)** — = ABOX-2: every real optimize attempt collects
  `result=None` → loop degenerates to "no-change".
- **OPT-3 (major)** `evals/checks.py:125-143` + `control/optimize.py:101-109`
  — winner selection driven entirely by **self-reported** metrics
  (bench times, complexity, `tests_run`, `changed_files`); nothing re-runs
  the benchmark or inspects the branch. A dishonest/mistaken attempt wins.
- **OPT-4 (major)** — default `required_suites=("schema","safety")` makes the
  decoy anti-churn guarantee false: failing all 5 decoys costs ~0.03 on the
  mean; a churny candidate can still reach `canary`.
- **OPT-5 (major)** `control/tools.py:74-85` — `_resolve_spec` returns
  `max(versions)` ignoring status: rejected candidates and archived versions
  shadow the active spec for all subsequent runs. Promotion/rejection is not
  enforced anywhere runs spawn.
- **OPT-6 (major)** — promotion lifecycle dead-ends: `Decision.promote`
  unreachable, `canary_percent`/`canary_min_runs` read by nothing, no code
  flips a version to `canary`/`active`, no rollback.
- **OPT-7 (major)** `api/server.py:143-145` — `/promotions/approve` trusts
  caller-supplied scorecards (never cross-checked against ledger
  `eval_results`) and drops `mutation_kinds` → fabricated approvals; human
  gate silently bypassed. (= API-7.)
- **OPT-8 (major)** — the LLM critic is dead code with three-way contract
  drift (`critic.yaml` result shape ≠ judge protocol ≠ eval consumption);
  "attempts judged by a critic model" is unimplemented.
- **OPT-9 (major)** — = TMP-11.
- **OPT-10 (major)** `api/server.py:95-141` — API `/optimize` uses
  `run_objective`'s default `local_sandbox`, bypassing the fail-closed
  `BAKUDO_SANDBOX` policy and never setting `BAKUDO_OFFLINE` → model-driven
  agent code executes **in the API server process on the host**.
- **OPT-11 (major)** — `Objective.repo` is routing-dead and the corpus's
  `payments-api` fixture repo doesn't exist → evolution grades the wrong
  codebase. (= ABOX-7.)
- **OPT-12 (minor)** — a *failed* scout is reported as `no-change` (the
  success outcome); infra failure indistinguishable from "already optimal".
- **OPT-13 (minor)** — `load_corpus` validates nothing: typo'd expectation
  keys silently weaken gates; missing fields raise bare `KeyError`.
- **OPT-14 (minor)** — corpus/evolution grading always uses `DEFAULT_SUITE`
  (never `OPTIMIZE_SUITE`) and drops runtime/tokens → optimizer evolution
  ignores perf/simplicity/cost.
- **OPT-15 (minor)** — critic judge: non-numeric score / non-dict JSON crash;
  abstention returns score 1.0 (inflates vs judged runs).
- **OPT-16 (minor)** — `PERF_NOISE_TOLERANCE` dead in `_eligible` (raw
  `perf < 0.5` check): noise-level regressions disqualify attempts the perf
  eval itself passed.
- **OPT-17 (minor)** — round feedback overwrites instead of accumulating;
  round-3 scout can re-propose round-1 dead ends.
- **OPT-18 (minor)** — `constraints.targetPaths` unenforced on live attempts;
  corpus `fnmatch` globs cross `/`.

## E. API / CLI / CI plane (`api/server.py`, `cli.py`, CI, packaging)

- **API-1 (major)** `api/server.py:147-151` — `GET /promotions/pending`,
  `GET /runs/{id}/logs`, `GET /objectives` have no auth, contradicting the
  HUMAN_TASKS §5 acceptance; run logs/diffs/backlog readable by anyone on
  the port.
- **API-2 (major)** `.github/workflows/ci.yml:34` — CI installs `[dev,api]`
  but httpx is in neither extra → `pytest.importorskip("httpx")` silently
  skips the **entire API test suite** in CI; mypy likewise runs without
  temporalio/strands/psycopg installed (`ignore_missing_imports`), hiding
  the exact bug classes 37c5db6 fixed.
- **API-3 (major)** — token budget never enforced: no caller sets
  `Budget.max_tokens` (`max_usd` fully dead), and `tokens_used` is only
  incremented after the agent loop ends, so the per-tool-call cap can never
  trip mid-run. `docs/operations.md:77-79`'s claim is false in every real
  flow.
- **API-4 (major)** — wall-clock budget bypassable in-process: deadline
  checked only at tool entry; `run-command` accepts a model-supplied
  `timeout` (default 600s, uncapped, not clamped to remaining budget); the
  in-process paths (API `/runs`, local sandbox) have no outer kill.
- **API-5 (major)** — = ABOX-2/ABOX-10 (result collection + dropped outcome
  fields).
- **API-6 (major)** — `/promotions/pending` returns `[]` on the durable
  ledger: `promotions()` exists only on `InMemoryLedger`, absent from the
  `Ledger` protocol; `PostgresLedger` writes but cannot read promotions.
- **API-7 (major)** — = OPT-7 (`/promotions/approve` approves nothing and
  trusts fabricated scorecards; spec §25.3 defines a different route shape).
- **API-8 (minor)** — `POST /runs` unusable via `bakudo serve` (no spec
  registration → always 404) and takes query params, not a body.
- **API-9 (minor)** — bogus `queue=` and bad scorecards return 500 (uncaught
  ValueError/ValidationError) instead of 422.
- **API-10 (minor)** — bearer token compared with `!=` (not constant-time);
  auth is fail-open when `BAKUDO_API_TOKEN` unset (contrast: sandbox
  selection fails closed).
- **API-11 (minor)** — stale docs: HUMAN_TASKS §1 and operations.md still
  instruct `git mv ci/python-ci.yml …` (already done by c553243; the file no
  longer exists); ci.yml's own header still claims it lives under `ci/`.
- **API-12 (minor)** — `bakudo demo`/`optimize` resolve `agents/*.yaml` via
  source-tree-relative paths; wheel installs (which only ship `schemas/` +
  `skills/`) crash with FileNotFoundError.

---

## Cross-cutting test gaps (why CI is green anyway)

1. No test executes the real abox binary; `test_abox_runner.py` pins a
   protocol abox 0.6.0 rejects (ABOX-12).
2. No `PostgresLedger` tests; no Temporal `WorkflowEnvironment` tests; the
   Pg memory tests use a `FakeConn` keyed on SQL substrings (TMP-2, MEM-9).
3. CI never installs httpx/temporalio/strands/psycopg → API suite skipped,
   mypy blind to the heavy extras (API-2).
4. No test covers the strands `@tool` integration (ABOX-19).
