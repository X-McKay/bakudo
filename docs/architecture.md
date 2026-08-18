# Architecture

bakudo is a **durable agent operating system**, not a single agent. This
document maps the [spec](spec.md) onto the code in `src/bakudo/`.

## Two planes

### Control plane (trusted)

Runs outside abox. It schedules and evaluates but never executes arbitrary
repository code. Components:

- **Meta-agent tools** (`control/tools.py`) — the *only* capabilities the
  control intelligence has (spec §4.3): create/list objectives, spawn/query/
  cancel runs, compare runs, create candidate specs/skills/evals, run eval
  suites, promote/archive candidates, query/write memory, query workflows/logs.
  There is deliberately **no** shell, filesystem, or arbitrary network tool.
- **Curriculum** (`curriculum/`) — the objective model, the priority formula
  (§16.4), and the named queues (§16.3).
- **Registry / ledger** (`registry/`) — the authoritative record of agent
  versions, runs, the run event log, evals, promotions, workload versions,
  measurements, diagnostic snapshots, comparisons, and regression signals.
  In-memory for dev and tests; Postgres for production
  (`registry/postgres_ledger.py`, DDL in `infra/postgres/init.sql`).
- **Evals & promotion** (`evals/`) — eval levels (§22.1), the scorecard
  (§15.2), and the promotion policy with hard safety gates and human gates
  (§15.3, §19.2).
- **Memory services** (`memory/`) — evidence-backed memory items, the write
  policy (§14.5), the in-process `SemanticMemoryStore` (embedding dedup +
  retrieval) and its durable counterpart `PgSemanticMemoryStore` (pgvector
  similarity server-side, auto-wired in the worker from
  `BAKUDO_POSTGRES_DSN`), and the FalkorDB graph adapter with an optional
  memory-write mirror (§14.2, §21).
- **Temporal** (`temporal/`) — durable orchestration (see below).
- **Control API** (`api/`) — the HTTP surface (§25).

### Worker plane (untrusted)

Runs inside abox. The **agent runner** (`runner/`) is the only bakudo code that
executes in the sandbox. It loads one versioned `AgentSpec`, builds a thin
Strands agent (`runner/agent.py`) wired to vLLM, exposes only the declared
scoped tools (`strands_tools/`) and skills (`skills/`), runs against one
objective, and writes a schema-valid `result.json` (`runner/result.py`).

## The run lifecycle

`AgentRunWorkflow` (`temporal/workflows.py`) implements the phases of §12.1:

```
created → bundle_rendered → sandbox_starting → agent_running
        → collecting_artifacts → evaluating → completed | failed | cancelled
```

Each phase transition is persisted to the ledger via the `persist_run`
activity. The same lifecycle runs **synchronously** in `control/pipeline.py`
(`run_objective`) so the system is demonstrable without a Temporal cluster — the
workflow and the pipeline call the same building blocks, so behavior matches.

### Activities vs workflows

Per §11.2, workflows are deterministic orchestration only; every side effect is
an activity (`temporal/activities.py`, implemented in `temporal/_impl.py`):
rendering the bundle, running the sandbox, persisting runs, running the eval
suite, and deciding promotions. The implementations live in plain functions so
they are unit-testable without the Temporal SDK.

Performance work follows the same rule. `PerformanceMeasurementWorkflow`,
`PerformanceCaptureWorkflow`, and `PerformanceComparisonWorkflow` only derive
retry-stable IDs, order work, retry activities, and relay cancellation. Source
reads, revision/environment validation, abox execution, profiler capture,
artifact writes, statistics, and ledger writes remain in injected activity
dependencies. The same `PerformanceMeasurementService` drives synchronous and
Temporal measurement/comparison semantics.

## The long-running meta-agent

`MetaAgentWorkflow` is an **entity workflow** (§11.3): it holds durable
high-level state (mode, active objectives/runs, pending promotions, budgets,
concurrency limits), reacts to **Signals** (`new_objective`, `run_completed`,
`pause/resume_autonomy`), answers **Queries** (`get_status`, `get_backlog`), and
accepts validated **Updates** (`submit_objective`, `change_budget`,
`change_concurrency_limit`). It uses **Continue-As-New** to bound history.

## Identifiers

One canonical ULID flows through every run system (§6.3): Temporal workflow id,
abox task id, Postgres run id, the `agent/<run_id>` git branch, and the log
correlation id. Performance operations also derive valid, role-scoped
`measurement_`, `snapshot_`, and `comparison_` IDs deterministically from the
operation ID, so an activity retry addresses the same durable records. See
`ids.py` and `temporal/shared.py`.

## The optimization loop

`OptimizationWorkflow` applies evidence-gated selection to code revisions. A
read-only `optimize-scout` proposes
distinct hypotheses; parallel single-hypothesis `optimize-attempt` child runs
implement them in sibling sandboxes; and the trusted control plane captures
each candidate patch and pins its digest. The candidate must first clear the
normal safety, task, and code gates. It is then measured against a
pinned baseline with the objective's exact `WorkloadPin`, `EnvironmentPin`,
metric policy, confidence, and protected metrics.

Only a completed, compatible, integrity-valid, statistically improved
`PerformanceComparison` whose patch digest matches the captured diff can be
eligible. Agent-reported or profiler-observed timing is advisory and never
enters selection. The pure selector (`control/optimize.py`) ranks eligible
candidates and otherwise returns `no-change`, feeding failure summaries into
the next bounded round. The fan-out lives in the trusted plane—workers never
schedule their own sub-agents—and behavior preservation remains a hard gate,
not a weighted score. `run_optimize_loop` is the synchronous in-process mirror
used by `bakudo optimize` and `POST /optimize`.

## Eval-first evolution

The meta-agent never overwrites an active agent. It creates candidate specs/
skills/evals, scores them against a baseline, and promotes only tested
improvements — gated on zero safety regressions, sufficient eval coverage, a
minimum score improvement, and human approval for privilege-escalating
  mutations. See `evals/promotion.py`.

## Controlled environment and experiment substrate

`tasks/` defines the storage-neutral environment boundary: typed `TaskSpec`
contracts, `TaskSource`, deterministic provisioning, published bundle loading,
the `VerifierRunner` port, and authoring verification. Core ships two smoke
tasks only. The versioned benchmark corpus and privileged verifier material
live in the separate private `bakudo-benchmarks` repository and are consumed
as a directory source or immutable content-addressed bundle.

A task-backed evaluation proceeds as:

```text
TaskSource → LoadedTask + TaskPin → provision episode → run policy
           → independent verifier → TrialRecord → experiment statistics
```

Experiments have one explicit subject discriminator and one normalized
observation boundary:

```text
AgentSpecSubject          → TrialRecord evidence ────┐
SoftwareArtifactSubject  → MeasurementRecord ID ────┤
                                                     ▼
                                        ExperimentObservation
                                                     ▼
                                    shared paired statistics/report
```

The artifact binding treats invalid evidence as contagious and retains exact
workload, revision, environment, and measurement IDs in its report. Behavioral
`experiment profile` mode exists only for a candidate-free agent subject;
instrumented performance capture is a separate record and command.

The synchronous and Temporal experiment paths share domain models,
deterministic pairing, persistence, and statistics. Side effects remain behind
small subject/source/runner ports so schemas, loading, provisioning,
verification, measurement, trials, and statistics can each be tested in isolation. See
[environment-model.md](environment-model.md) for the POMDP correspondence and
[task-corpus-and-bundles.md](task-corpus-and-bundles.md) for artifact ownership.

## Performance evidence substrate

`performance/` is a set of small control-plane components, not a second
experiment system:

```text
WorkloadSource → LoadedWorkload + WorkloadPin
       + RevisionPin + EnvironmentPin
       → fresh uninstrumented invocations → MeasurementRecord
       → paired bootstrap analysis       → PerformanceComparison

same immutable workload/pins + ProfilerSpec
       → diagnostic capture → restricted ArtifactRef + PerformanceSnapshot
```

- `WorkloadSpec` declares a shell-free command, environment requirements,
  measurement schedule, typed metrics, thresholds, and optional profilers.
- A `WorkloadPin` binds source URI/kind, collection revision, manifest,
  datasets, executors, and bundle digest. `RevisionPin` and `EnvironmentPin`
  bind the code and execution environment separately.
- `PerformanceMeasurementService` schedules warmups and measured invocations;
  the abox invoker gives each invocation a fresh guest. Failed, missing,
  non-finite, or mismatched samples invalidate the metric instead of being
  dropped.
- Comparison recomputes summaries and dispersion from raw samples, checks the
  pinned plan and environment correspondence, and uses deterministic paired
  bootstrap intervals plus practical thresholds. Primary/protected metrics and
  integrity decide eligibility.
- Profiling is diagnostic capture, not measurement. Adapters perform bounded
  capability checks and normalization; raw output is content-addressed and
  restricted; snapshots can identify hotspots but cannot prove a speedup.
- Regression policy consumes persisted comparisons only. Exact approved
  workload pins, recurrence, confidence/sample floors, hysteresis, cooldown,
  deduplication, and repository concurrency limits gate signal/objective
  creation.

Target-repository evidence remains separate from Bakudo's phase-level
self-observability. `observability/` defines safe, low-cardinality monotonic
span names for control-plane phases. Instrumentation currently covers run,
bundle render, sandbox preparation, report extraction, verification,
measurement, statistical analysis, and ledger persistence, and can aggregate
p50/p95, error/timeout rates, and exclusive attribution. It does not export raw
payloads or turn Bakudo's own latency into candidate-selection evidence.

See the [environment terminology](environment-model.md) for canonical record
names and [security.md](security.md) for the measurement trust rationale.
