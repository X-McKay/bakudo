# Performance measurement substrate implementation plan

Status: IMPLEMENTED 2026-08-17

Implementation note: PR-sized sections below are retained as the delivery
record. The canonical current interfaces and operator workflows are documented
in `docs/environment-model.md`, `docs/architecture.md`, `docs/cli.md`, and
`docs/operations.md`. The NeMo Gym-compatible remote runner remains the
explicitly non-blocking follow-on described in section 8.

Design source:
[2026-08-17-performance-measurement-design.md](../specs/2026-08-17-performance-measurement-design.md)

This plan delivers the design as small, independently testable pull requests.
It deliberately establishes trusted measurement before connecting autonomous
optimization or curriculum. There is no compatibility layer for
`benchCommand`, `bench_seconds_before`, or `bench_seconds_after`: the old path
is removed in the cutover PR after its structured replacement is working.

## 1. Delivery principles

1. **Pure domain first.** Models, pin compatibility, sample validation,
   statistics, normalization, and regression policies are testable without
   abox, Temporal, Postgres, or external profilers.
2. **Ports before adapters.** Execution, profiler, workload source, artifact
   storage, and telemetry boundaries are protocols with deterministic fakes.
3. **One vertical slice at a time.** Each PR leaves the repository green and
   exposes no CLI/API promise until the underlying path is real.
4. **Independent proof.** No optimization cutover occurs until a candidate can
   be remeasured without profiling in a fresh sandbox.
5. **Clean break.** Once the replacement path lands, old schema fields, prompts,
   eval logic, implementation, tests, and documentation are deleted together.
6. **Contract parity.** In-memory and production adapters run the same contract
   tests.
7. **Bounded data.** Numeric samples are bounded; large profiles are stored by
   content digest rather than embedded in ledger rows.
8. **No premature services.** Packages are independently testable and have
   explicit ports; deployment remains in the current worker until measurement
   justifies another process boundary.

Every PR runs the offline gate:

```bash
ruff check src tests skills scripts
python -m mypy src/bakudo
python -m pytest
```

Relevant adapter PRs also run opt-in live tests against real abox/Postgres and
record their environment pins in the test report.

## 2. Dependency sequence

```text
PR 1 contracts and schemas
  |
  +--> PR 2 workload loading and pinning
  |       |
  |       +--> PR 3 measurement and comparison core
  |                    |
  |                    +--> PR 4 sandbox measurement + smoke slice
  |                    |       |
  |                    |       +--> PR 6 workflow / CLI / API
  |                    |                 |
  |                    |                 +--> PR 7 optimize clean cutover
  |                    |                           |
  |                    |                           +--> PR 8 curriculum
  |                    |
  |                    +--> PR 5 diagnostic capture adapters
  |                              |
  |                              +--> PR 6 workflow / CLI / API
  |
  +--> PR 9 artifact experiment binding

PR 10 Bakudo self-observability can begin after PR 1 and lands after PR 6.
PR 11 hardening, documentation, and removal audit closes the program.
```

PR 9 is intentionally after the optimize cutover in delivery priority even
though its contract design begins in PR 1. Repository observation and trusted
optimization gain value before the general software-artifact experiment
binding is exposed.

## 3. PR 1 — Domain contracts and canonical schemas

Size: M. Dependencies: none.

### Outcome

Introduce the performance vocabulary and frozen domain contracts with no
execution or persistence. Make invalid states difficult to represent.

### Add

- `src/bakudo/performance/__init__.py`
- `src/bakudo/performance/models.py`
- `src/bakudo/performance/pins.py`
- `src/bakudo/performance/compatibility.py`
- `schemas/workload-spec.schema.json`
- `schemas/performance-record.schema.json`
- `tests/test_performance_models.py`
- `tests/test_performance_pins.py`
- `tests/fixtures/performance/valid-workload.yaml`
- `tests/fixtures/performance/invalid-workloads/`

### Change

- `src/bakudo/schema.py` — register both schemas with the same model/schema
  parity mechanism used by AgentSpec and TaskSpec.
- `src/bakudo/paths.py` and `pyproject.toml` — make installed-resource lookup
  work from wheels.
- `tests/test_schema.py` and packaging tests — assert source and wheel parity.

### Contracts

Implement strict, extra-forbid models for:

- `WorkloadMetadata`, `WorkloadCommand`, `DatasetSpec`,
  `WorkloadEnvironment`, and `WorkloadSpec`;
- `MetricDefinition`, `MeasurementPlan`, and `ProfilerSpec`;
- `WorkloadPin`, `RevisionPin`, and `EnvironmentPin`;
- `MetricSampleSet` and `MeasurementRecord`;
- `ProfilerDescriptor`, `RawProfileArtifact`, `Hotspot`, and
  `PerformanceSnapshot`;
- `MetricComparison`, `PerformanceComparison`, and
  `PerformanceRegressionSignal`;
- typed status, direction, estimator, schedule, verdict, hotspot-kind, and
  failure-reason enums.

All persisted models use camelCase aliases at the JSON boundary and explicit
schema versions. Domain constructors use precise types internally. IDs use the
existing canonical ULID helper. Datetimes are timezone-aware UTC. Digests are
validated `sha256:<hex>` values.

### Decisions encoded now

- `command.argv` is a non-empty string array; there is no shell command field.
- `workloadRef` is a structured name/version/source reference.
- metrics declare unit, direction, estimator, and practical threshold.
- raw samples have a configurable hard count limit.
- records and snapshots contain all three pins.
- comparison verdict is explicit and cannot be inferred solely from a signed
  numeric delta.
- extension maps are namespaced and bounded.

### Tests

- JSON Schema and Pydantic accept/reject the same fixtures.
- canonical serialization has stable key order and stable digest.
- path traversal, shell-like scalar commands, unknown fields, non-finite
  samples, invalid units, duplicate metrics, naive timestamps, and malformed
  digests fail with precise paths.
- pin compatibility reports every mismatch deterministically.
- property-style round trips preserve semantically relevant values.

### Acceptance gate

The models can represent the complete smoke flow, all invalid fixtures fail
closed, and the installed wheel can load both schemas.

## 4. PR 2 — Workload source, verification, and immutable pinning

Size: M. Dependencies: PR 1.

### Outcome

Load workloads from a directory or content-addressed bundle, verify their
inputs, and return an immutable `LoadedWorkload` + `WorkloadPin` before any
candidate mutation occurs.

### Add

- `src/bakudo/performance/source.py`
- `src/bakudo/performance/bundle.py`
- `src/bakudo/performance/verify.py`
- `tests/test_workload_source.py`
- `tests/test_workload_bundle.py`
- `tests/test_workload_verify.py`

### Reuse deliberately

Extract generic content-addressing and safe-archive helpers from
`src/bakudo/tasks/bundle.py` only if doing so leaves task behavior unchanged.
A suitable destination is `src/bakudo/artifacts/bundle.py`; task and workload
formats remain separate adapters over that utility. Do not make a
`WorkloadSpec` a subtype of `TaskSpec`.

### Ports and adapters

```python
class WorkloadSource(Protocol):
    def list(self) -> tuple[WorkloadSummary, ...]: ...
    def load(self, ref: WorkloadRef) -> LoadedWorkload: ...

class DirectoryWorkloadSource: ...
class BundleWorkloadSource: ...
```

`LoadedWorkload` includes a read-only resolved root, the validated model,
provenance, and pin. Loading hashes the manifest, dataset, executable scripts,
and bundle before returning.

### Verification checks

- manifest/model/schema parity;
- all relative paths remain below the workload root;
- referenced data and scripts exist and match declared digests;
- command executable/script is included in the pin;
- environment can only tighten the selected sandbox posture;
- metric names and sources are supported;
- profiler options satisfy the selected adapter schema when installed;
- canonical bundle construction is byte-deterministic;
- workload version/digest collision is rejected.

### Tests

- directory and bundle adapters load identical pins;
- tar entry traversal, symlinks escaping root, duplicate entries, oversized
  entries, digest mismatch, and manifest ambiguity fail closed;
- two bundle builds from identical inputs are byte-for-byte identical;
- candidate-tree mutations after load cannot change resolved input bytes;
- source listing is deterministic.

### Acceptance gate

Given a workload directory, Bakudo can verify it, build a canonical bundle,
load it through either source, and prove input immutability in a unit test.

## 5. PR 3 — Measurement scheduling, samples, statistics, and comparison

Size: L. Dependencies: PR 1; uses PR 2 fixtures.

### Outcome

Build the proof-producing logic independently of real process execution.

### Add

- `src/bakudo/performance/measurement.py`
- `src/bakudo/performance/comparison.py`
- `src/bakudo/performance/statistics.py` if generic extraction is not cleaner
- `src/bakudo/performance/artifacts.py`
- `tests/test_measurement_schedule.py`
- `tests/test_measurement_samples.py`
- `tests/test_performance_comparison.py`
- `tests/test_performance_artifacts.py`

### Ports

```python
class MeasurementRunner(Protocol):
    def measure(self, request: MeasurementRequest) -> MeasurementRecord: ...

class ArtifactStore(Protocol):
    def put(self, artifact: ArtifactInput) -> ArtifactRef: ...
    def get(self, ref: ArtifactRef) -> bytes: ...
```

Provide `SyntheticMeasurementRunner` and `InMemoryArtifactStore` for unit
tests. The synthetic runner consumes fixed sample series and failure scripts,
not wall time.

### Statistical work

- Extract a generic paired-bootstrap primitive from
  `src/bakudo/experiments/statistics.py`, retaining exact agent-experiment
  behavior and golden tests.
- Generate deterministic randomized-pair and ABBA schedules from a stored seed.
- Validate warmups separately from measured repetitions.
- Compute estimator, dispersion, absolute/relative effect, confidence interval,
  and protected-metric status.
- Make `inconclusive` contagious when required evidence is invalid.
- Require threshold and confidence rules for `improved` or `regressed`.
- Refuse p95/p99 if configured sample sufficiency is not met.

### Tests

- fixed seeds produce fixed schedules;
- sign handling is correct for higher-is-better and lower-is-better metrics;
- clear speedup, clear regression, practical tie, noisy/inconclusive, timeout,
  missing sample, NaN/Inf, and protected-secondary regression cases;
- mismatched pins cannot be compared;
- bootstrap results are deterministic for a fixed analysis seed;
- existing experiment-statistics golden results remain unchanged;
- artifact digest, duplicate put, size bound, and missing artifact behavior.

### Acceptance gate

A deterministic fake baseline/candidate run can produce all four verdicts and
the comparison cannot be made favorable by dropping invalid samples or changing
metric direction.

## 6. PR 4 — Abox measurement runner and smoke vertical slice

Size: L. Dependencies: PRs 2–3.

### Outcome

Execute uninstrumented workloads in fresh abox guests and prove the entire
load → pin → schedule → measure → compare path on a tiny packaged workload.

### Add

- `src/bakudo/abox/measurement.py`
- `src/bakudo/performance/service.py` — plain orchestration functions shared by
  sync and Temporal entry points
- `smoke/workloads/python-loop/workload.yaml`
- `smoke/workloads/python-loop/run.py`
- `tests/test_abox_measurement.py`
- `tests/test_performance_service.py`
- `tests/test_performance_live.py` marked `live`

### Change

- `pyproject.toml` — include the smoke workload in wheel artifacts.
- `src/bakudo/paths.py` — resolve packaged smoke workload resources.
- abox runner utilities — extract only reusable sandbox lifecycle and bounded
  output helpers; preserve current trial and benchmark semantics.

### Runner behavior

- creates a fresh guest/worktree per scheduled side or a rigorously reset guest
  when the sandbox adapter can prove equivalent isolation;
- applies the exact `RevisionPin` and pinned workload copy;
- uses argv execution, declared cwd/env, network policy, timeout, CPU/memory
  limits, and bounded stdout/stderr;
- records wall time outside the workload process and process/resource metrics
  from the trusted runner;
- validates workload-emitted metrics against declarations;
- cleans up on completion, timeout, cancellation, and partial failure;
- rejects dirty persistent baselines and detects candidate modification of
  measurement-plane inputs.

### Tests

- scripted abox client tests for command construction, timeout, cancellation,
  bounded logs, cleanup, invalid metric output, and non-zero exits;
- an offline fake-runner vertical slice;
- a live abox test compares intentionally slow and fast fixture revisions and
  obtains a valid improvement;
- a tampering fixture edits the workload and is rejected;
- wheel-install smoke lists and validates the packaged workload.

### Acceptance gate

The faster live fixture can win only through independently collected,
uninstrumented samples. A claimed metric in repository output cannot override
runner data or integrity failure.

## 7. PR 5 — Diagnostic capture, normalization, and first adapters

Size: L. Dependencies: PRs 2–4.

### Outcome

Add useful hotspot evidence without contaminating the proof path.

### Add

- `src/bakudo/performance/profiler.py`
- `src/bakudo/performance/normalize.py`
- `src/bakudo/abox/profiler.py`
- `src/bakudo/performance/adapters/synthetic.py`
- `src/bakudo/performance/adapters/process.py`
- `src/bakudo/performance/adapters/python_sampling.py`
- `tests/test_profiler_contract.py`
- `tests/test_profile_normalization.py`
- `tests/test_profiler_abox.py`
- `tests/test_profiler_live.py` marked `live`

### Capability spike

Before selecting the production Python adapter, run both candidate mechanisms
inside the supported abox image:

- `py-spy` sampling, including whether required process capabilities can be
  granted to the guest without host privilege;
- `cProfile` as a lower-capability fallback when repository invocation can be
  wrapped safely.

Record startup overhead, steady-state overhead, stack/source quality, failure
behavior, required image changes, and security posture. Prefer sampling if it
works without widening the host boundary. This result becomes a short review
under `docs/superpowers/reviews/`.

### Adapter rules

- descriptor and capability check are side-effect-free;
- capture output is written only to a runner-provided bounded directory;
- raw artifacts are hashed before leaving the guest;
- normalization is pure and stable for a fixed artifact/symbol map;
- unknown frames are retained with a quality flag, not silently dropped;
- paths are repository-relative and scrubbed;
- profiler-measured wall time is labelled diagnostic and excluded from
  `PerformanceComparison` inputs by type/API.

### Tests

- contract suite runs against synthetic and real adapters;
- canonical hotspot ordering and stable-key generation;
- recursion, native/unknown frames, missing symbols, malformed artifact,
  excessive artifact, and secret/path redaction;
- explicit unsupported/degraded capability states;
- type-level/service-level test that a snapshot cannot satisfy a measurement
  input;
- live capture points to the deliberately hot function in the smoke fixture.

### Acceptance gate

Bakudo can create a normalized snapshot and raw artifact reference for the
smoke workload, while selection continues to use only the PR 4 uninstrumented
record.

## 8. PR 6 — Persistence, Temporal workflows, CLI, API, and doctor

Size: XL; split into 6A persistence and 6B surfaces if review size exceeds the
repository norm. Dependencies: PRs 3–5.

### Outcome

Make captures and comparisons durable and operable through consistent sync and
Temporal paths.

### Add or change: persistence

- `src/bakudo/registry/records.py` — typed metadata records.
- `src/bakudo/registry/ledger.py` — workload, measurement, snapshot,
  comparison, and regression protocol methods.
- `src/bakudo/registry/postgres_ledger.py` — production parity.
- `infra/postgres/init.sql` — append-oriented tables, FKs, uniqueness, and
  indexes from the design.
- `tests/test_performance_ledger_contract.py` — parametrized contract for
  in-memory and scripted/live Postgres.
- `tests/test_performance_postgres_live.py` marked `live`.

Required indexes support repository/workload/revision/time listing and
comparison lookup. Idempotency keys are unique. Metadata and artifact writes
either commit atomically through an outbox/finalization state or leave an
explicit incomplete operation that cannot be consumed.

### Add or change: orchestration

- `src/bakudo/temporal/shared.py` — serializable capture/compare inputs/results.
- `src/bakudo/temporal/activities.py` and `_impl.py` — load, measure, capture,
  normalize, persist, compare, and cleanup activities.
- `src/bakudo/temporal/workflows.py` — `PerformanceMeasurementWorkflow`,
  `PerformanceCaptureWorkflow`, and `PerformanceComparisonWorkflow`.
- `src/bakudo/temporal/worker.py` — registrations.
- `tests/test_performance_workflows.py` — replay-safe orchestration and retries.

Workflow code handles ordering and state only. Every source read, repository
operation, sandbox run, artifact write, clock read, and ledger write is an
activity or deterministic input.

### Add or change: operator surfaces

- `src/bakudo/cli.py` — `workload` and `performance` command groups.
- `src/bakudo/api/server.py` — workload/capture/comparison/read routes.
- `src/bakudo/doctor.py` — source, artifact store, abox measurement, and
  profiler capability checks.
- `tests/test_cli_performance.py`
- `tests/test_api_performance.py`
- `tests/test_doctor.py`
- `docs/cli.md` and `docs/operations.md`

### UX details

- sync mode is explicit for local development; production create calls return
  workflow/operation IDs;
- progress uses stderr and final records use stdout;
- `--json` has stable objects for success and typed failure;
- `show` accepts any measurement/snapshot/comparison ID and reports its kind;
- capability failures name the missing tool/image permission and remediation;
- destructive artifact cleanup is not part of the first command surface.

### Tests

- retrying activities does not duplicate records or artifacts;
- cancellation records terminal state and cleans guests;
- API and CLI serialize the same domain result;
- JSON output contains no progress noise;
- in-memory and Postgres list/filter/order behavior matches;
- Temporal time-skipping covers success, inconclusive, unsupported, timeout,
  cancellation, activity retry, and persistence failure.

### Acceptance gate

A user can validate a workload, measure one revision, capture a diagnostic
snapshot, compare revisions, inspect the records, and diagnose unavailable
capabilities from both source checkout and installed wheel. Sync and Temporal
results have the same semantic fields.

### Non-blocking follow-on: NeMo Gym-compatible remote runner

After the local/abox contract passes, a separate adapter PR may implement a
remote `MeasurementRunner`/`ProfilerRunner` for NeMo Gym or a comparable
service. Keep vendor request/response models in
`src/bakudo/performance/adapters/remote_gym.py`; do not leak them into core
models.

The adapter contract tests must cover bundle upload/pinning, idempotent remote
operation IDs, cancellation, bounded logs/artifacts, sample provenance,
environment compatibility, alternating placement, and network/auth redaction.
A live test must measure the same synthetic workload locally and remotely and
document any semantic mismatch. Until environment equivalence and input
integrity are demonstrated, mark remote records `screening-only` so they can
guide hypotheses but cannot select or promote a candidate. This adapter is not
on the critical path for PR 7.

## 9. PR 7 — Optimize loop clean cutover

Size: XL. Dependencies: PRs 4 and 6. This is the compatibility-breaking PR.

### Outcome

Replace free-form/self-reported benchmark selection with pinned workloads and
independent `PerformanceComparison` evidence.

### Schema/model changes

- `src/bakudo/curriculum/objective.py` and `schemas/objective.schema.json`:
  replace `constraints.benchCommand` with a structured `performance` block:

```yaml
performance:
  workloadRef:
    name: webhook-throughput
    version: "1.0.0"
    source: repo
  primaryMetric: latency_seconds
  decisionPolicy:
    confidence: 0.95
    minimumRelativeImprovement: 0.05
    protectedMetrics: [peak_rss_bytes]
```

- Optimize API input and CLI replace `benchCommand` / `--bench` with
  `workloadRef` / `--workload` and optional explicit source/version flags.
- `schemas/result.schema.json` removes the optimization description of
  `bench_seconds_before/after`. Generic agent metrics remain only if another
  real consumer exists; otherwise remove the unused metrics map as a separate
  cleanup in this PR.

### Control-flow changes

- `src/bakudo/control/optimize.py` loads/pins workload before scout/attempt
  execution and supplies a sanitized snapshot summary to the scout.
- `src/bakudo/temporal/workflows.py` binds the same immutable workload pin into
  every attempt and starts independent comparison for eligible candidates.
- Winner selection consumes `PerformanceComparison`, behavior verification,
  simplicity/scope evidence, and integrity status.
- Candidate-reported performance fields are ignored by construction, then
  removed from prompts and result fixtures.
- Optional post-win capture is explanatory and asynchronous to the verdict.

### Delete

- `src/bakudo/abox/bench.py` once its only behavior has moved into the generic
  measurement runner.
- `perf_eval` logic in `src/bakudo/evals/checks.py` that reads
  `bench_seconds_before/after`.
- all `benchCommand`, `--bench`, and `bench_seconds_*` prompt/schema/API/CLI
  paths and tests.
- no alias, deprecation parser, migration branch, or compatibility shim.

Retain `src/bakudo/abox/verifier_bench.py` only if it is still genuinely used
for task authoring verification; rename it if “bench” no longer describes the
behavior.

### Tests

- update `tests/test_optimize.py`, `tests/test_optimize_loop.py`,
  `tests/test_temporal_workflows.py`, and `tests/test_api.py` around structured
  evidence;
- a candidate claiming a huge speedup but measuring slower loses;
- a profiled candidate timing cannot enter comparison samples;
- workload tampering, behavior regression, protected metric regression, or
  incompatible pin makes a candidate ineligible;
- a real improvement wins; noisy evidence returns no-change;
- multi-round feedback references comparison evidence and failures without
  exposing privileged raw artifacts;
- `rg` assertion/test prevents the deleted field names from returning outside
  historical review documents, if those documents are intentionally retained.

### Acceptance gate

All optimize entry points require a valid workload reference and every winning
performance claim points to a persisted independent comparison. The repository
contains no live legacy benchmark-selection implementation.

## 10. PR 8 — Proactive regression collection and curriculum

Size: L. Dependencies: PRs 6–7.

### Outcome

Turn reliable regressions into one bounded, evidence-pinned optimization
objective and avoid noisy autonomous churn.

### Add or change

- `src/bakudo/performance/regressions.py`
- `src/bakudo/curriculum/observe.py` — add typed regression signals to
  `RepoSignals`.
- `src/bakudo/curriculum/collectors.py` —
  `PerformanceRegressionCollector`.
- `src/bakudo/curriculum/objective.py` — deterministic objective mapping and
  priority inputs.
- `src/bakudo/temporal/workflows.py` — observer scheduling/reconciliation.
- ledger query methods for capture windows, active dedup keys, cooldowns, and
  objective evidence lineage.
- `tests/test_performance_regressions.py`
- `tests/test_performance_collector.py`
- `tests/test_observe.py`
- `tests/test_temporal_workflows.py`

### Policy

- only approved workloads are eligible;
- compare a newly measured revision against a configured pinned release or
  rolling baseline policy;
- require threshold, confidence, minimum samples, and consecutive observation
  count;
- deduplicate by repository/workload/metric/baseline-policy/hotspot key;
- apply create/recover hysteresis and no-change/failure cooldown;
- cap concurrent performance objectives per repository and global resource
  cost;
- snapshot paths are advisory targets; objective evidence pins remain primary;
- record why a signal did not create an objective.

### Tests

- one valid repeated regression produces exactly one deterministic objective;
- noisy, invalid, unapproved, one-off, already-owned, cooling-down, recovered,
  or over-budget signals produce none with a reason;
- higher-is-better and lower-is-better metrics map correctly;
- changes in top hotspot do not duplicate an already-owned workload regression
  unless policy explicitly splits them;
- Continue-As-New preserves cooldown and deduplication behavior;
- objective dispatch reaches `OptimizationWorkflow` with the exact workload and
  evidence pins.

### Acceptance gate

A scripted repository slowdown is detected and creates one optimize objective;
repeated observation does not create duplicates, and an inconclusive recovery
does not cause flip-flop.

## 11. PR 9 — Software-artifact experiment binding

Size: XL. Dependencies: PRs 3, 6, and preferably 7.

### Outcome

Generalize the existing experiment layer so agent/task experiments and
software-artifact/workload experiments share design, statistics, evidence
lineage, and reports without conflating their observations.

### Design change

Add a discriminated subject to `ExperimentSpec`:

- `AgentSpecSubject` retains current baseline/candidate agent versions and task
  selection;
- `SoftwareArtifactSubject` declares repository, baseline/candidate
  `RevisionPin` inputs, and `WorkloadRef` selection.

Extract a small `ObservationProvider`/subject-binding port used by the
experiment runner. The agent binding returns `TrialRecord` observations. The
artifact binding returns observations that reference `MeasurementRecord` IDs.
Both feed generic named metric pairs into one statistics implementation.

### Add or change

- `src/bakudo/experiments/models.py`
- `schemas/experiment-spec.schema.json`
- `src/bakudo/experiments/design.py`
- `src/bakudo/experiments/runner.py`
- `src/bakudo/experiments/statistics.py`
- `src/bakudo/experiments/subjects.py`
- `src/bakudo/experiments/artifact_subject.py`
- experiment ledger records/tables where subject kind must be indexed.
- Temporal/API/CLI experiment dispatch and rendering.
- `tests/test_artifact_experiment.py`
- existing agent experiment tests as backward-semantic regression coverage.

This is a schema evolution of `ExperimentSpec`, not compatibility with the
deleted benchmark fields. Because the project is pre-release, update all seed
specs and callers to the new explicit agent subject in the same PR; do not keep
an implicit old form.

### Tests

- agent experiments retain paired seeds, statistics, cost tie-break, integrity
  gates, and profile-mode meaning;
- artifact experiments use paired measurement schedules and cannot reference
  task rewards as performance metrics;
- profile mode remains a single-arm behavioral agent experiment; performance
  capture remains a different command and record kind;
- mixed subject candidates are rejected;
- persistence and reports expose subject kind and exact pins;
- golden reports cover both bindings.

### Acceptance gate

One engine runs both subject kinds with shared statistical output and distinct
typed observation records. No user-facing term has two meanings.

## 12. PR 10 — Bakudo phase-level self-observability

Size: L. Dependencies: PR 1 for metric vocabulary; land after PR 6 for useful
workflow coverage.

### Outcome

Expose where Bakudo itself spends time without coupling domain code to a
telemetry vendor or leaking sensitive payloads.

### Add

- `src/bakudo/observability/__init__.py`
- `src/bakudo/observability/spans.py`
- `src/bakudo/observability/policy.py`
- `src/bakudo/observability/summary.py`
- `tests/test_observability_spans.py`
- `tests/test_observability_policy.py`
- `tests/test_observability_summary.py`

### Change

- instrument boundaries in `control/pipeline.py`, performance service,
  Temporal activity implementations, abox runners, verifier runners, model/tool
  loop, and ledger adapters;
- add optional OpenTelemetry dependencies/configuration to `pyproject.toml`,
  `.env.example`, `infra/`, and `docs/operations.md`;
- extend `bakudo doctor` with exporter readiness;
- add a read-only summary endpoint/CLI view only if the configured backend can
  provide it reliably; otherwise document backend-native queries first.

### Implementation rules

- domain modules receive a minimal `SpanSink`/context, with a no-op default;
- stable span names and allowlisted attributes come from one module;
- high-cardinality content and secrets are rejected/scrubbed at the sink;
- monotonic duration is captured around actual boundaries;
- tracing failure never changes run semantics;
- trace sampling and export are bounded and configurable;
- ledger stores aggregated regression summaries only, not raw spans.

### Tests

- fake sink records the required nesting and phase durations;
- allowlist prevents prompts, command text, env values, tool payloads, and raw
  errors from being emitted;
- exporter failure is non-fatal;
- cancellation/error paths close spans with correct status;
- a synthetic trace produces expected p50/p95/phase attribution;
- no-op path has negligible contract overhead and no dependencies.

### Acceptance gate

An operator can distinguish queue, sandbox startup, model, tool, verification,
measurement, and persistence latency for a run, and automated secret fixtures
prove forbidden payloads are not exported.

## 13. PR 11 — Hardening, live validation, documentation, and legacy audit

Size: L. Dependencies: PRs 1–10 for full program; may close an initial release
after PRs 1–8 and revisit PRs 9–10 independently.

### Outcome

Validate the trust model and developer experience end to end, remove temporary
or duplicated implementation, and make the supported surface unambiguous.

### Live validation matrix

Run against at least:

- packaged Python smoke workload;
- one real CPU-bound workload;
- one I/O- or allocation-sensitive workload if supported;
- fresh baseline/candidate abox guests on the same environment pin;
- Postgres persistence with Temporal retries and cancellation;
- selected Python profiler and process sampler;
- source checkout and installed wheel.

Exercise: improvement, regression, equivalent, noisy/inconclusive, timeout,
workload failure, profiler unsupported, raw artifact corruption, candidate
tampering, environment mismatch, cancellation, and partial infrastructure
failure.

### Security review

- workload/bundle archive traversal and resource exhaustion;
- sandbox privilege and network policy;
- measurement-plane file integrity;
- artifact access controls, secret scanning, and retention;
- command/env serialization and log redaction;
- Temporal retry/idempotency and orphan cleanup;
- hostile profiler output and normalization bounds;
- objective poisoning/deduplication/cooldown;
- proof that diagnostic timings cannot enter selection.

### Documentation

Update:

- `README.md` — component map, quickstart, status, and canonical links;
- `docs/architecture.md` — performance subsystem and both measurement scopes;
- `docs/environment-model.md` — artifact-subject correspondence and precise
  distinction among task observations, measurements, captures, and comparison;
- `docs/experiment-loop.md` — replace “later artifact binding” with the real
  implementation state and remove ambiguous “profile baseline” language where
  needed;
- `docs/cli.md` — full workload/performance UX, JSON shapes, errors, examples;
- `docs/operations.md` — artifact store, profiler images/capabilities,
  telemetry, retention, capacity, and incident checks;
- `docs/security.md` — workload and profile trust boundaries;
- `docs/spec.md` — canonical high-level requirements;
- `.claude/skills/bakudo-maintenance/` and
  `.codex/skills/bakudo-maintenance/` — new components, test commands,
  terminology, integrity invariants, and legacy-name prohibition.

### Legacy/removal audit

Search code, schemas, tests, agents, skills, smoke data, docs, CI, and package
metadata for:

```text
benchCommand
bench_command
--bench
bench_seconds_before
bench_seconds_after
self-reported before/after
profile result
performance oracle
```

Historical validation reports may preserve old facts when clearly dated. Live
guidance and code may not. Also identify duplicated statistics, archive safety,
digesting, sandbox execution, status enums, and JSON rendering introduced
during delivery and collapse them behind the intended single component.

### Developer-experience review

- run every new command first as a maintainer and then from an installed wheel;
- verify `--help`, example correctness, shell completion where present, stable
  exit codes, stderr/stdout separation, and `--json` on success/failure;
- ensure unsupported capability messages explain exactly how to resolve them;
- keep common local validation independent of Postgres/Temporal/abox;
- add focused Make targets only when they name a meaningful gate, for example
  `test-performance` and `test-performance-live`;
- verify each component's contract test can run alone.

### Acceptance gate

- offline gate passes;
- live matrix passes with a recorded validation report;
- source and wheel smokes pass;
- docs and both maintenance skills agree with schemas and commands;
- no stale live implementation or terminology remains;
- a maintainer can identify the correct focused test from the component name;
- the final architecture still has one experiment/statistics system and small
  replaceable execution/storage/telemetry ports.

## 14. CI strategy

### Per-commit offline CI

- schema/model parity and packaging;
- all pure contract and fake-adapter tests;
- synthetic end-to-end capture/compare/optimization/curriculum path;
- security fixtures for paths, archives, output bounds, and redaction;
- ruff, mypy, and full pytest.

### Privileged integration CI

- real abox workload execution;
- process sampler and chosen profiler capabilities;
- cancellation and cleanup;
- source/wheel packaged smoke workload.

### Durable integration CI

- Postgres migration from an empty database;
- in-memory/Postgres ledger contract parity;
- Temporal replay/time-skipping, retries, and idempotency;
- object-store adapter contract if/when chosen.

### Scheduled stability CI

Performance thresholds should not gate ordinary shared-runner CI until the
runner is controlled. A scheduled job on a pinned hardware class tracks the
smoke workload, reports noise and drift, and alerts on measurement-system
instability. Functional assertions (correct scheduling, sample count, pins,
verdict construction) remain normal CI gates.

## 15. Rollout and kill switches

Roll out in these modes:

1. **Manual-only:** workload validate/capture/compare; no collector.
2. **Observe-only:** scheduled baselines and regression reports; objective
   creation disabled.
3. **Objective-draft:** collector creates pending objectives requiring human
   approval.
4. **Autonomous bounded:** approved workloads may dispatch optimization under
   repository/global budgets and concurrency caps.

Independent controls disable scheduled capture, each profiler adapter,
regression-to-objective creation, and artifact experiment dispatch without
disabling ordinary agent/task experiments. Disabling profiling must not disable
uninstrumented verification.

## 16. Program completion criteria

The performance program is complete when all of the following are true:

- exact workload/revision/environment pins accompany every record;
- diagnostic capture and proof-producing measurement are separate in types,
  processes, APIs, and tests;
- the optimize loop contains no self-reported performance selection path;
- regression collection is confidence-aware, deduplicated, hysteretic, and
  budgeted;
- agent and artifact experiments use one statistics/reporting substrate;
- Bakudo phase latency is observable without sensitive payloads;
- in-memory, Postgres, synchronous, Temporal, source, and wheel paths have
  semantic parity;
- both maintenance skills and all canonical docs teach the new vocabulary;
- live validation demonstrates useful attribution and trustworthy independent
  speedup measurement on current abox infrastructure.
