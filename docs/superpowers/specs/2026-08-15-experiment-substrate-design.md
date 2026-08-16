# Experiment Substrate: ScenarioSpec, Trial, and the Experiment Layer

**Status:** approved design, pending implementation plan
**Date:** 2026-08-15
**Source:** "Bakudo Agent Lab, Agent Simulator, and Software Evolution Engine" proposal (2026-08-15), Phases 1–2 + minimal statistics
**Branch:** `feature/experiment-substrate`

---

## 1. Context and Motivation

Bakudo already has the control-plane machinery a scientific experimentation
platform needs: versioned `AgentSpec` artifacts with a
candidate→canary→active state machine, an optimization loop with
scout→attempts→hard gates→independent verification→`no-change`, a single
eval assembler, enforced budgets and concurrency, and evidence-backed
memory. What it lacks is the **measurement apparatus**:

- No `ScenarioSpec`. The nearest analogue is the eval corpus
  (`EvalCase`/`Expectations` in `src/bakudo/evals/corpus.py`), and its 25
  optimize cases reference a fictional `payments-api` repo — the corpus is
  unrunnable against real code.
- No `Trial`. Per-case results (`CaseRun`) collapse into aggregate
  `EvalResult` rows; no persisted record of one agent×scenario execution
  with pinned versions and seeds exists.
- No statistics. The only aggregation is mean-of-scorecards
  (`_window_stats`) and a fixed 0.05 delta threshold. No pairing, no
  confidence intervals, no holdouts, no seeds anywhere in the system.

The guiding rule, from the source proposal:

> **Build the measurement apparatus before increasing autonomy.**

This spec covers exactly that substrate. Mutation machinery, statistical
promotion, Pareto/routing, the generalized Evolution Engine, and the
Scenario Factory are explicitly later phases.

An additional cross-cutting requirement: the substrate must be
**agent-authorable**. Coding agents (Claude Code, Codex) should be able to
generate scenarios, experiment specs, and candidate agent specs from a
high-level objective, with a machine-checkable verification loop that
makes generated artifacts trustworthy without human review of each one.
This is the on-ramp to the autonomous system the proposal describes.

## 2. Goals

1. `ScenarioSpec`: a versioned, reproducible, self-contained environment
   definition with hidden ground truth, authored as files in-tree.
2. A runnable starter corpus of ~25 scenarios across four families:
   debugging, no-change, adversarial-context, safety/scope-discipline.
3. `Trial`: an immutable, persisted record of one AgentSpec × ScenarioSpec
   × seed execution, pinned to exact versions of everything that matters.
4. `ExperimentSpec`/`ExperimentResult`: paired candidate-vs-baseline trial
   matrices with honest statistics (paired bootstrap CI, exact McNemar,
   Wilson intervals) and hard safety gates.
5. Operator surface: `bakudo sim …` and `bakudo lab …` CLI plus API
   routes, all with `--json` output.
6. Agent-authorability: scaffolding, a closed verification loop
   (`bakudo sim verify`), actionable validation errors, provenance
   tracking, and an authoring skill.
7. Everything runs offline (`BAKUDO_OFFLINE=1`) end-to-end in CI.

## 3. Non-Goals (this phase)

- AgentSpec mutation model beyond what exists (prompt mutation), lineage
  tables, failure-driven candidate generation (Phase 3).
- Rewiring `PromotionPolicy` to require experiment evidence (Phase 4).
  This phase produces the evidence object; promotion consumes it later.
- Pareto frontier, task feature extraction, routing (Phase 5).
- `EvolutionObjective`/`ArtifactCandidate` generalization (Phase 6).
- Scenario Factory automation (Phase 7). Agent-authored scenarios are
  supported and verified, but the failure→scenario pipeline is manual.
- `TeamSpec` (Phase 8).
- Perturbation engine, service sidecars, fault injection, clock control —
  these need abox extensions. Adversarial content in this phase is
  authored directly into fixtures (misleading issue text, deceptive
  comments/READMEs), which covers the adversarial-context family without
  new runtime capability.
- Gymnasium/PettingZoo adapters. Evaluated and rejected as the core
  abstraction (§13). Their seeding and versioned-environment-registry
  conventions are adopted instead.

## 4. Data Model

```
ScenarioSpec  (files in git, versioned)   the world
Trial         (Postgres, immutable)       one AgentSpec × ScenarioSpec × seed execution
ExperimentSpec/Result (Postgres)          paired trial matrix + statistics
```

A trial is fully determined by:

```
Trial = AgentSpec × Objective(derived) × ScenarioSpec × seed × runtime pins
```

- New ID prefixes in `src/bakudo/ids.py`: `trial_`, `exp_` (ULID-based,
  same as existing prefixes).
- New JSON Schemas: `schemas/scenario-spec.schema.json`,
  `schemas/experiment-spec.schema.json`, mirrored by `_Strict` pydantic
  models (camelCase aliases, `extra="forbid"`), same convention as
  `AgentSpec`.
- `schemas/eval-result.schema.json` subject-type enum gains `trial`.
- Scenarios are **not** stored in Postgres. They are versioned files in
  git (like `agents/` seed specs). A Trial pins a scenario by
  `name@version` **plus a content digest** computed over the scenario
  directory. A test fails the build if scenario content changes without a
  version bump (the Gymnasium `Env-v3` immutability convention, enforced).

## 5. ScenarioSpec

### 5.1 On-disk layout

```
evals/scenarios/<name>/
  scenario.yaml      # the spec
  fixture/           # project tree materialized into the agent's repo
  hidden/            # hidden tests + grading assets — never enter agent workspace
  reference/         # ground-truth patch proving the scenario is solvable
```

Packaged into the wheel like `agents/` and `skills/` (a `paths.py`
resolver + `force-include` entry + packaging-test update).

### 5.2 scenario.yaml shape

```yaml
apiVersion: bakudo.ai/v1alpha1
kind: ScenarioSpec

metadata:
  name: duplicate-webhook-delivery
  version: 1
  family: debugging            # debugging | no-change | adversarial-context | safety
  difficulty: medium
  tags: [python, race-condition]
  partition: dev               # dev | validation | holdout
  provenance:
    createdBy: human           # or an agent ref, e.g. scenario-author@3
    sourceType: hand-written   # hand-written | historical-bug | agent-failure | ...
    eligibleForPromotion: true # false until verified for agent-authored scenarios

mission:                       # becomes the Objective handed to the agent
  type: qa                     # existing ObjectiveType values
  title: Diagnose duplicate webhook delivery
  description: >
    Users occasionally receive duplicate payment notifications. Find the
    root cause and implement a safe fix.
  acceptanceCriteria: [...]
  constraints:
    maxFilesChanged: 4

environment:
  profile: python-glibc        # guest profile hint
  network: none                # none | scoped; most-restrictive-wins vs agent spec

budgets:                       # min() with the agent spec's budget — can only tighten
  wallSeconds: 1800
  toolCalls: 60
  tokens: 40000

hidden:
  tests: [hidden/test_no_duplicates.py]
  testCommand: "pytest hidden -q"
  expectedFiles: [app/webhook.py]

expect:                        # existing Expectations semantics, kept
  status: completed
  changesPaths: [app/]
  maxChangedFiles: 4
  forbidsDeniedCommands: true
```

Notes:

- `mission` maps onto the existing `Objective` model; no new objective
  type is required for the four starter families (they use `qa`,
  `optimize`, `maintenance` as appropriate). If a dedicated type is later
  needed, both the JSON Schema enum and `ObjectiveType` must change
  together (they are dual-sourced).
- `no-change` scenarios express ground truth as `expect.maxChangedFiles: 0`
  plus hidden tests that verify behavior is unchanged — the planted-decoy
  pattern from the retired optimize corpus, made real.
- `budgets` and `environment.network` can only **restrict** what the agent
  spec allows, never loosen it. Intersection logic lives in pure code and
  is unit-tested.

### 5.3 Provisioning

`src/bakudo/scenarios/provision.py` materializes `fixture/` into a
throwaway git repository:

- sorted file walk, fixed author identity and timestamp, single initial
  commit → byte-identical repos for the same scenario+seed;
- the seed is available to templated fixture values (rare; most fixtures
  are static) following the Gymnasium `reset(seed=…)` convention: seed is
  an explicit input to environment construction, recorded on the Trial;
- the provisioner only ever **writes** fixture files; it never executes
  them (the `abox/bench.py` discipline). Fixture content is adversarial by
  design and only runs inside the guest;
- the content digest (scenario.yaml + fixture/ + hidden/ + reference/,
  hashed over sorted relative paths and bytes) is computed here and is the
  value Trials pin.

The provisioned repo path is handed to the existing `AboxRunner` repo
resolution; no runner changes are needed beyond accepting an absolute
provisioned path.

### 5.4 Registry and loader

`src/bakudo/scenarios/` package: `models.py` (pydantic), `loader.py`
(YAML → model with schema validation), `registry.py` (discover, filter by
family/tags/partition, digest computation, version-immutability check).

## 6. Trial

### 6.1 Execution flow

New `trials/` package following the repo's proven three-part pattern
(pure logic + thin Temporal workflow + synchronous mirror):

- **Pure logic** (`trials/runner.py`): scenario → Objective derivation,
  budget/network intersection, trial-record assembly.
- **`TrialWorkflow`** (thin, deterministic): provision scenario → launch
  the existing `AgentRunWorkflow` as a child (unchanged — it already owns
  ledger writes, sandbox lifecycle, cancel racing, evals) → hidden
  evaluation activity → persist Trial → cleanup.
- **Sync mirror** (`trials/sync.py` or equivalent) for CLI/offline use,
  exactly as `run_optimize_loop` mirrors `OptimizationWorkflow`.

### 6.2 Hidden evaluation

Reuses the independent-verification pattern from `abox/bench.py`:

1. control plane takes the trial's diff (the only durable artifact of the
   agent's work);
2. applies it host-side to a fresh worktree of the pristine provisioned
   fixture (file writes only, never executed);
3. copies `hidden/` in;
4. runs `hidden.testCommand` in a fresh `--network safe` guest;
5. records the outcome as a `hidden` eval suite with subject_type `trial`.

Invariants: the agent's sandbox never contains `hidden/`; hidden tests
never run in a workspace the agent shaped beyond its diff.

### 6.3 Trial record

Persisted fields (jsonb where structured):

- identity: `id` (`trial_`), optional `experiment_id`, `run_id`,
  `objective_id`;
- subject: agent ref (`name@version`), scenario `name@version`, scenario
  content digest, seed;
- runtime pins: bakudo version, abox version (already probed by
  `verify_binary`), model id + endpoint ref, guest profile;
- execution metrics (mirrored from the existing observability keys):
  duration, input/output tokens, tool calls, denied actions, changed
  files, diff bytes;
- evaluation: scorecard, hidden-suite outcome, expectation results;
- `status` and timestamps.

Immutability: trials are insert-only; no update path exists on the ledger
interface.

## 7. Experiment Layer

### 7.1 ExperimentSpec

```yaml
apiVersion: bakudo.ai/v1alpha1
kind: ExperimentSpec

metadata:
  name: debugger-prompt-ablation

subject: agent-spec
baseline: debugger@17
candidates: [debugger@18]

scenarioSelector:
  families: [debugging]
  tags: []
  partitions: [dev, validation]
  count: 20

repetitions: 2
useHoldout: false              # holdout partition excluded unless explicitly true

metrics:
  primary: [task_success]
  secondary: [tokens, tool_calls, duration]

hardGates:
  safetyRegressions: 0

decision:
  method: paired-bootstrap
  confidence: 0.95
  minImprovement: 0.03
```

### 7.2 Paired design

`experiments/design.py` builds the trial matrix: for each selected
scenario × repetition, one baseline trial and one trial per candidate,
**sharing a seed** derived deterministically as
`hash(experiment_id, scenario_name, repetition)` — no RNG in workflow
code, consistent with the repo's hashing-over-RNG convention
(`routes_to_canary`, `deterministic_objective_id`).

Holdout leakage guard: `partition: holdout` scenarios are excluded from
selection unless `useHoldout: true`, and that flag is stamped into the
`ExperimentResult` so holdout exposure is auditable.

### 7.3 Statistics

`experiments/statistics.py`, **stdlib only** (preserves the light-core
dependency rule; no scipy/numpy):

- paired bootstrap CI for continuous score deltas (seeded `random.Random`,
  deterministic given the experiment id);
- exact McNemar via binomial tail for paired pass/fail;
- Wilson score interval for success rates.

Roughly 150 lines, unit-tested against known distributions and closed-form
cases.

### 7.4 ExperimentResult

Reports, per candidate vs baseline:

- paired win / loss / tie counts;
- mean and median score delta with bootstrap CI;
- per-family deltas (the counterfactual view: "clean debugging unchanged,
  misleading-hypothesis +18pp");
- cost deltas: tokens, tool calls, duration;
- safety regressions (any > 0 ⇒ `eligibleForPromotion: false` regardless
  of capability — hard gate);
- an **advisory** promotion verdict (`eligibleForPromotion`, rationale).
  Promotion policy itself is unchanged this phase.

### 7.5 ExperimentWorkflow

Resolve scenarios → build matrix → fan out `TrialWorkflow` children with
bounded concurrency (the `asyncio.gather(..., return_exceptions=True)` +
crash-tolerant-candidate pattern from `OptimizationWorkflow`) → aggregate
→ statistics → persist result. A crashed trial becomes a recorded failed
trial, not a lost data point. Token usage accumulates and reports to the
meta-agent via the existing `_notify_meta` convention when parented by it;
standalone experiments (CLI-started) skip it.

## 8. Persistence

- New tables `trials` and `experiments` (spec + status + result jsonb) in
  `infra/postgres/init.sql` **and** as idempotent self-migration DDL
  constants (the `_GRAPH_MIRROR_OUTBOX_DDL` pattern), because `init.sql`
  only runs at first cluster init and existing dev databases must
  converge.
- `Ledger` protocol grows: `record_trial`, `get_trial`,
  `list_trials(experiment_id=…)`, `record_experiment`,
  `update_experiment_result`, `get_experiment`. Implemented in both
  `InMemoryLedger` and `PostgresLedger` with parity tests.
- Workflow registration in `temporal/worker.py`; new activities join
  `Deps`, `configure()`, and `ALL_ACTIVITIES`; starters land in
  `temporal/client.py` (unlike `AgentEvolutionWorkflow`, these ship with
  real entry points: CLI + API).

## 9. Corpus Absorption and Compatibility

- `run_corpus()` keeps its signature but becomes a thin adapter: it loads
  scenarios and delegates to the trial runner; `EvalCase`/`Expectations`
  survive as the adapter's view. Callers (`evolve_agent`, eval paths) see
  no behavior change. One "run an agent in a controlled environment"
  abstraction underneath.
- `evals/corpora/add-feature.yaml` cases become real fixture-backed
  scenarios. `evals/corpora/optimize.yaml` (fictional, unrunnable) is
  retired; its planted-inefficiency/decoy pattern is reborn as real
  fixtures in the no-change family.
- Targeted fix en route: `deterministic_objective_id` emits `objd_…` but
  `schemas/objective.schema.json` pins `^obj_…`; fixed so
  scenario-derived and observer objectives pass validation uniformly.

### 9.1 Starter corpus (~25)

| Family | Count | Content |
|---|---|---|
| debugging | 8 | planted bugs (race, off-by-one, stale cache, wrong conditional…) with hidden regression tests |
| no-change | 6 | already-optimal code, misleading perf comments, already-fixed issues — ground truth is `maxChangedFiles: 0` |
| adversarial-context | 6 | misleading issue hypothesis, deceptive README/comments, salient-but-irrelevant error in logs |
| safety / scope-discipline | 5 | tempting out-of-scope edits, instructions in repo content, denied-command handling |

Each scenario small enough to run repeatedly; the corpus is
infrastructure, not test data.

## 10. Agent-Authorability

The substrate is designed so a coding agent can generate scenarios,
experiment specs, and candidate agent specs from a high-level prompt, with
machine verification closing the loop:

1. **Scaffolding**: `bakudo sim scaffold <name> --family <f>` emits a
   commented template tree (scenario.yaml with inline docs, fixture/,
   hidden/, reference/ stubs).
2. **Closed verification loop**: `bakudo sim verify <scenario>` checks,
   in order:
   - schema-valid `scenario.yaml`;
   - fixture provisions deterministically (digest stable across two runs);
   - hidden tests **fail** on the pristine fixture (the planted problem is
     real) — skipped for no-change scenarios, where they must pass;
   - hidden tests **pass** with `reference/` patch applied (the problem is
     solvable);
   - version-immutability check against the registry.
   A scenario that passes `verify` is structurally sound by construction.
3. **Actionable errors**: schema and verify failures emit JSON-pointer
   paths and remediation hints; every CLI command supports `--json`.
4. **Provenance and anti-poisoning**: `metadata.provenance.createdBy`
   records the generating agent; agent-authored scenarios default to
   `eligibleForPromotion: false` until verified, and scenario generators
   must not immediately benefit from their own scenarios (the separation
   the source proposal requires; full enforcement arrives with the
   Scenario Factory phase, but the fields and defaults land now).
5. **Authoring skill**: a scenario-authoring skill ships in the repo's
   `skills/` tree — layout, invariants, family-specific checklists,
   verify-loop usage — written for consumption by coding agents.
6. **Experiment/candidate generation**: `ExperimentSpec` and candidate
   `AgentSpec`s are plain schema-validated YAML — the format agents
   already generate reliably. `bakudo lab compare A B --family f --count n`
   generates and runs an ExperimentSpec without authoring a file at all.

## 11. Operator Surface

CLI (subcommands on the existing `bakudo` entry point):

```
bakudo sim list [--family --partition --json]
bakudo sim scaffold <name> --family <f>
bakudo sim verify <scenario> [--json]
bakudo sim run <scenario> --agent <name[@ver]> [--seed N] [--json]
bakudo lab run <experiment.yaml> [--json]
bakudo lab compare <baseline> <candidate> --family <f> --count N [--json]
bakudo lab result <exp_id> [--json]
```

API (same bearer-auth pattern as existing routes): `POST /experiments`,
`GET /experiments/{id}`, `GET /trials/{id}`.

## 12. Testing and Security

**Testing**

- Entire path runs under `BAKUDO_OFFLINE=1` with the existing
  deterministic driver: provision → trial → experiment → statistics in CI
  with no model.
- Unit: provisioning determinism (byte-stable digests), digest-vs-version
  enforcement, budget/network intersection (tighten-only), seed
  derivation/pairing, statistics vs known distributions, holdout guard,
  hidden-test isolation, `verify` semantics per family.
- Ledger parity tests for the new methods on both implementations.
- Temporal workflow tests following the existing
  `test_temporal_workflows.py` patterns.
- Live e2e behind the same gating as `test_abox_live.py`.

**Security invariants** (existing posture, extended)

- Fixtures and hidden tests are data until executed in-guest; the control
  plane never executes fixture content.
- Hidden evaluation runs in a fresh `--network safe` guest.
- Scenario budgets/network can only tighten the agent spec's, never
  loosen.
- No new secret surfaces; env forwarding unchanged.
- Agent-authored scenario provenance defaults are fail-closed
  (`eligibleForPromotion: false`).

## 13. Alternatives Considered

**Gymnasium / PettingZoo as the environment abstraction — rejected.**
Gymnasium's contract is step-level MDP interaction with the caller owning
the policy loop. A bakudo trial is episode-level: the agent loop runs
autonomously inside an untrusted abox guest, mediated by abox policy, not
by a Python API between steps. Making bakudo a real Gym env would either
move the agent loop into the control plane (dissolving the
trusted/untrusted boundary) or reduce `step()` to "run the whole trial"
(one-step episodes; the interface becomes ceremony). Gym's machinery
(spaces, vector envs, wrappers) serves tensor-exchanging policies, not
"a git worktree, a Postgres fixture, and an incident log." PettingZoo
models simultaneous/turn-based games; TeamSpec topologies are pipelines of
complete runs. **Adopted from them instead**: the `reset(seed=…)` seeding
discipline and the versioned immutable environment-ID registry
convention. A thin Gym adapter remains possible later (deterministic
seeded provisioning + versioned scenarios + machine-readable outcomes)
if gradient-based RL training ever becomes a goal; explicitly out of
scope now. Closer prior art (Inspect, SWE-bench harness) informed the
ScenarioSpec field shape but would duplicate abox/Temporal if adopted
wholesale.

**Layer alongside the existing corpus (no absorption) — rejected.** Two
permanent overlapping scenario abstractions; evolution/promotion paths
would keep standing on the unstatistical one.

**Extend `corpus.py` in place — rejected.** No persisted trial identity,
no experiment object, no reproducibility pinning; does not deliver the
substrate.

## 14. Risks

- **Corpus authoring dominates the phase.** Mitigated by the scaffold +
  verify loop (agents can draft scenarios; verification is mechanical) and
  by capping at ~25.
- **Offline driver fidelity.** The canned offline result exercises
  plumbing, not agent behavior; statistical code is therefore tested
  against synthetic distributions, not just offline trials.
- **Fan-out cost on live runs.** A 20-scenario × 2-rep × 2-arm experiment
  is 80 sandboxed runs. Bounded concurrency + budgets apply; experiments
  report token usage to the meta-agent's ledger when parented by it.
- **Schema evolution.** Two `additionalProperties: false` walls
  (objective, eval-result) are extended deliberately and minimally.

## 15. Build Order (for the implementation plan)

1. Schemas + pydantic models + ids (`ScenarioSpec`, `ExperimentSpec`,
   trial/experiment records).
2. Scenario registry, loader, digest, provisioner + determinism tests.
3. Trial pure logic + sync runner + hidden evaluation + ledger
   persistence (both backends).
4. `bakudo sim` CLI (list/scaffold/verify/run) + first scenarios to prove
   the loop.
5. Experiment design (pairing, seeds, holdout guard) + statistics module.
6. Experiment sync runner + `bakudo lab` CLI + API routes.
7. `TrialWorkflow`/`ExperimentWorkflow` + worker registration + starters.
8. Corpus buildout to ~25 + corpus-adapter absorption of `run_corpus`.
9. Authoring skill + docs.
