# Performance measurement and profiling substrate

Status: ACCEPTED AND IMPLEMENTED 2026-08-17

This document is the retained design rationale. Canonical current interfaces
and operator instructions live in `docs/environment-model.md`,
`docs/architecture.md`, `docs/cli.md`, and `docs/operations.md`.

Audience: Bakudo maintainers implementing artifact optimization, repository
observation, experiments, and operational telemetry.

Related documents:

- [environment-model.md](../../environment-model.md) defines the canonical
  agent-task experiment vocabulary.
- [experiment-loop.md](../../experiment-loop.md) defines the common
  evidence-and-promotion loop.
- [architecture.md](../../architecture.md) defines the trusted control plane
  and untrusted worker plane.
- [task-corpus-and-bundles.md](../../task-corpus-and-bundles.md) defines the
  ownership and pinning pattern this design reuses for workloads.
- The executable delivery sequence is in
  [2026-08-17-performance-measurement-implementation.md](../plans/2026-08-17-performance-measurement-implementation.md).

## 1. Decision

Bakudo should add a first-class **performance measurement substrate**. It
should measure target repositories and Bakudo itself, identify likely
bottlenecks, convert sufficiently strong regressions into optimization
objectives, and independently establish whether a candidate made performance
better or worse.

This belongs in Bakudo because it is another controlled experiment over a
versioned subject. It does not require a separate experiment product, a new
agent hierarchy, or an initial fleet of microservices. The first implementation
should consist of small ports and pure domain components within the current
control plane; expensive runners and stores remain replaceable adapters.

The governing invariant is:

> **Profiles identify likely causes; independent, uninstrumented measurements
> prove performance improvements.**

A profiler changes the program it observes. Profiled duration is therefore
diagnostic evidence, never the reward used to select or promote a candidate.
Final comparisons rerun the pinned workload without the profiler in a fresh,
equivalently pinned environment outside the candidate's mutable surface.

## 2. Goals and non-goals

### 2.1 Goals

1. Detect latency, throughput, CPU, memory, allocation, I/O, and similar
   regressions before a human must notice them.
2. Attribute regressions to stable code-level hotspots when the available
   profiler can do so.
3. Reproduce comparisons under pinned workloads, revisions, datasets,
   environments, executors, and analysis rules.
4. Let the curriculum create bounded `optimize` objectives from valid
   performance evidence.
5. Give the optimize scout a sanitized causal summary while keeping workloads,
   raw profiler data, and independent verification out of its reach.
6. Reuse Bakudo's experiment statistics, ledger, sandbox, orchestration, and
   governance concepts wherever their semantics genuinely match.
7. Measure Bakudo's own orchestration latency by phase so control-plane
   bottlenecks are distinguishable from target-program bottlenecks.
8. Keep measurement, normalization, comparison, persistence, collection, and
   optimization independently testable.

### 2.2 Non-goals for the first release

- Continuous production profiling or automatic capture of live customer
  traffic.
- Kernel-wide or host-level profiling that bypasses abox isolation.
- Support for every language profiler.
- A second experiment, statistics, or promotion framework.
- Treating a flame graph, one benchmark run, or an agent's claimed speedup as
  proof.
- Automatically merging changes solely because they are faster. Behavioral,
  safety, integrity, and scope gates remain mandatory.
- Splitting every component into a deployed network service. Module boundaries
  come first; independent deployment is justified only by load or trust.

## 3. Vocabulary

Bakudo already uses `experiment profile` for a single-arm behavioral
fingerprint and `sandbox.profile` for an execution-environment selection. The
new command group and package therefore use **performance**, and the operation
that records diagnostic data is a **capture**.

| Term | Meaning |
|---|---|
| **WorkloadSpec** | A versioned, declarative program invocation and measurement plan used to exercise a software artifact. |
| **WorkloadSource** | A storage-neutral loader for workload manifests and their immutable inputs. |
| **LoadedWorkload** | A validated `WorkloadSpec`, resolved assets, provenance, and `WorkloadPin`. |
| **WorkloadPin** | Exact source, collection revision, workload version, spec digest, dataset digest, and executor digest used in a run. |
| **RevisionPin** | Exact repository revision under measurement: repository identity, commit, tree digest, and optional patch digest/base. |
| **EnvironmentPin** | Exact execution conditions that can affect results: image, hardware class, CPU allocation, OS, runtimes, dependencies, and relevant configuration digests. |
| **MeasurementPlan** | Warmups, repetitions, ordering, timeout, metrics, estimator, and practical threshold. |
| **MetricDefinition** | Name, unit, direction, collection source, estimator, and validity rules for one metric. |
| **MetricSampleSet** | Raw uninstrumented samples plus validity, summary, and dispersion for one metric. |
| **MeasurementRecord** | Immutable result of executing one pinned workload against one pinned revision without diagnostic profiling. |
| **ProfilerSpec** | Configuration for one diagnostic adapter, including capabilities, sampling settings, and resource limits. |
| **PerformanceSnapshot** | Immutable normalized diagnostic evidence for one revision, with hotspots and references to raw artifacts. |
| **Hotspot** | A normalized code, call-stack, endpoint, query, allocation, or resource location associated with measured cost. |
| **PerformanceComparison** | A paired baseline/candidate effect estimate, confidence interval, practical-threshold verdict, integrity result, and optional hotspot delta. |
| **PerformanceRegressionSignal** | A curriculum input produced from a valid, practically meaningful regression. |

Do not use `oracle`, `judge`, `profile result`, `benchmark truth`, or `agent
speedup` for these concepts. A workload defines observations; a measurement
records samples; a comparison makes the statistical decision.

## 4. Two measurement scopes

The design serves two related but deliberately separate scopes.

### 4.1 Target-repository performance

This path runs a pinned `WorkloadSpec` against a pinned repository revision in
an abox guest. It produces uninstrumented measurements, optional diagnostic
captures, comparisons, regression signals, and optimization evidence.

Target-repository measurements may directly influence curriculum and candidate
selection, so the full measurement-plane trust boundary applies.

### 4.2 Bakudo control-plane latency

This path records Bakudo's own phase timings and resource use: queue wait,
bundle rendering, sandbox preparation, model first-token latency, model
generation, tool execution, report extraction, verification, statistics, and
persistence.

It uses trace/span instrumentation rather than executing a `WorkloadSpec`.
Detailed traces belong in a telemetry backend; only bounded summaries and
regression evidence belong in Bakudo's ledger. Control-plane traces must not
record prompts, credentials, environment values, tool payloads, or raw model
responses by default.

The two scopes may share metric definitions, artifact storage, comparison
logic, and reports. They must not share an execution adapter or blur the trust
boundary.

### 4.3 Relationship to the formal environment model

The performance substrate aligns with Bakudo's POMDP vocabulary without
pretending that a profiler itself is a POMDP environment:

| Environment concept | Software-artifact binding |
|---|---|
| hidden state | complete code/repository state, runtime state, cache state, and external conditions |
| observation | bounded metric samples and sanitized diagnostic hotspots |
| action | candidate patch proposed by the optimization policy |
| transition | applying the candidate patch and executing the pinned workload |
| reward | independently measured performance effect, subject to practical thresholds |
| constraints | behavior preservation, integrity, scope, safety, and protected metrics |
| episode | one pinned revision × workload × measurement schedule execution |

The optimization policy acts between measurements; the workload runner does
not need a step-by-step Gym API. `PerformanceSnapshot` is partial diagnostic
observation, not ground truth about causality. `PerformanceComparison` is an
experiment result, and its performance reward remains separate from hard
constraints exactly as in task-backed trials.

## 5. Architecture

```text
WorkloadSource -> LoadedWorkload + WorkloadPin
                         |
             provision pinned environment
                  /                   \
     MeasurementRunner             ProfilerRunner
      (profiler disabled)           (diagnostic only)
             |                           |
     MeasurementRecord            raw profile artifact
                                         |
                                    Normalizer
                                         |
                               PerformanceSnapshot
                  \                   /
                   PerformanceComparator
                             |
                  PerformanceComparison
                    /                  \
       RegressionDetector        optimize verification
                |                         |
       curriculum collector       selection/promotion gate
```

### 5.1 Component responsibilities

`performance.models`
: Frozen domain models, validation, canonical serialization, and digests. It
  performs no I/O.

`performance.source`
: Storage-neutral workload discovery/loading. Initial adapters are directory
  and content-addressed bundle sources, mirroring `tasks.source` without
  coupling the two formats.

`performance.measurement`
: The `MeasurementRunner` port, scheduling logic, sample validation, summary
  calculation, and a deterministic fake runner for tests.

`performance.profiler`
: `ProfilerRunner` and `ProfilerAdapter` ports, capability discovery, capture
  lifecycle, and adapter metadata. It does not decide whether a candidate won.

`performance.normalize`
: Converts adapter-specific output into stable `Hotspot` values. Normalizers
  are pure given a raw artifact and symbol/source mapping.

`performance.comparison`
: Paired effects, confidence intervals, practical thresholds, verdicts, and
  validity checks. It reuses or extracts generic statistical primitives from
  `experiments.statistics` rather than implementing a competing recipe.

`performance.artifacts`
: A small content-addressed `ArtifactStore` port. Postgres stores metadata and
  references; raw profiles and large sample attachments live outside rows.

`performance.regressions`
: Converts valid comparisons or repeated baseline observations into stable,
  deduplicated `PerformanceRegressionSignal` values.

`observability`
: Bakudo self-latency spans, safe attribute policy, and summary export. This is
  separate from workload execution.

### 5.2 Process boundaries

The domain and orchestration components initially run in the control-plane
worker. Workload measurement and profiling execute in abox guests. The
artifact store and trace backend may be external infrastructure.

A component becomes an independently deployed service only when one of these
conditions is demonstrated:

- it needs a different trust boundary;
- it needs independent scaling or specialized hardware;
- its resource usage can starve orchestration;
- it has an independently useful API and operational owner.

This preserves microservice-ready contracts without imposing distributed
failure modes on the initial implementation.

### 5.3 NeMo Gym and other remote environment runners

The source and runner ports intentionally leave room for a NeMo Gym-compatible
or similar remote environment adapter. That adapter would provision the pinned
workload/revision in the remote environment and return Bakudo's typed raw
samples or diagnostic artifacts; Bakudo would continue to own normalization,
comparison, evidence lineage, curriculum policy, and promotion decisions.

Remote execution is not automatically trusted measurement. It becomes eligible
for candidate proof only if the adapter can establish equivalent environment
pins, alternating/randomized baseline and candidate placement, input integrity,
bounded execution, cancellation, and raw-sample provenance. Without those
guarantees, remote rollouts remain useful for hypothesis generation, training,
or broad noisy screening but not final selection. The core contracts therefore
do not depend on a particular Gym service or SDK.

## 6. Workload contract

### 6.1 Proposed manifest

```yaml
apiVersion: bakudo.ai/v1alpha1
kind: WorkloadSpec
metadata:
  name: webhook-throughput
  version: "1.0.0"
  description: Measures sustained webhook dispatch throughput
  labels:
    service: payments
    criticality: high

subject:
  repo: payments-api

command:
  argv: ["python", "benchmarks/webhooks.py", "--dataset", "datasets/webhooks-v2.jsonl"]
  cwd: "."
  env:
    PYTHONHASHSEED: "0"

dataset:
  path: datasets/webhooks-v2.jsonl
  digest: sha256:...

environment:
  profile: python-small
  network: none
  cpuCount: 2
  memoryMb: 2048

measurement:
  warmups: 2
  repetitions: 10
  timeoutSeconds: 60
  schedule: randomized-pairs
  metrics:
    - name: latency_seconds
      unit: seconds
      direction: lower
      source: wall-clock
      estimator: median
      practicalThreshold: 0.05
    - name: peak_rss_bytes
      unit: bytes
      direction: lower
      source: process
      estimator: median
      practicalThreshold: 0.10

profilers:
  - name: python-sampling
    adapter: py-spy
    signals: [cpu-samples]
    options:
      samplingHz: 100
```

### 6.2 Manifest rules

1. `command.argv` is an array and is executed without a shell. Complex setup
   belongs in a reviewed repository script invoked by the array.
2. The workload must emit only adapter-declared metric output; arbitrary text
   is retained as bounded logs but cannot synthesize undeclared metrics.
3. Paths are relative, normalized, and cannot escape the provisioned root.
4. Environment values are allowlisted. Secrets are referenced by opaque names,
   never serialized into a `WorkloadPin` or record.
5. The task's candidate diff cannot modify the pinned workload, dataset,
   executor, or measurement plan used for verification.
6. A repository workload is loaded from the baseline revision before an agent
   runs and is executed from a content-addressed copy. A candidate cannot alter
   its verifier by editing `.bakudo/workloads` in the candidate tree.
7. A workload can tighten an execution profile but cannot widen host, network,
   filesystem, or profiler privileges.

### 6.3 Ownership

Core owns schemas, loaders, verification, orchestration, statistics, and one
tiny deterministic smoke workload for package integration. Target-specific
workloads belong either:

- in the onboarded repository under `.bakudo/workloads/`, reviewed with that
  code but pinned from the baseline revision; or
- in a separately controlled private workload corpus when datasets, traffic
  shapes, or measurement logic must remain privileged.

Published workload bundles are immutable content-addressed artifacts. This is
the same clean ownership boundary used by task bundles, but workload and task
manifests remain different contracts because their lifecycle and integrity
rules differ.

## 7. Pinning and reproducibility

Every `MeasurementRecord` and `PerformanceSnapshot` includes all three pins:

### 7.1 WorkloadPin

- source URI and source kind;
- collection/corpus revision;
- workload name and semantic version;
- canonical manifest digest;
- dataset/fixture digests;
- executor script digest;
- bundle digest when loaded from a bundle.

### 7.2 RevisionPin

- registered repository identity and source;
- commit SHA;
- git tree digest;
- dirty-state prohibition for persistent baseline captures;
- optional base commit and canonical patch digest for a candidate.

### 7.3 EnvironmentPin

- abox and Bakudo versions;
- sandbox image digest and environment profile name;
- hardware class, architecture, allocated CPU count/affinity, and memory;
- OS/kernel and relevant runtime versions;
- dependency lock digest;
- non-secret measurement environment digest;
- profiler adapter/version for snapshots only.

A comparison is invalid by default if workload or environment pins are
incompatible. An explicit compatibility policy may allow known-safe differences
(for example, Bakudo patch version) and must record that decision.

## 8. Measurement semantics

### 8.1 Uninstrumented records

A `MeasurementRecord` contains:

- identity, timestamps, pins, and invocation provenance;
- warmup outcomes and measured repetition outcomes;
- for each metric: raw samples, valid/invalid sample count, estimator, summary,
  dispersion, unit, and direction;
- timeout, exit status, bounded logs, and failure classification;
- integrity result and any incompatible-pin reason;
- content digests for attached raw sample artifacts.

Warmups are never included in the estimate. Missing, non-finite, unit-mismatched,
timed-out, or policy-invalid samples produce an explicit invalid/inconclusive
record; they are never converted to zero or silently discarded until a result
appears favorable.

### 8.2 Comparison design

Candidate proof uses paired baseline/candidate execution under the same
`WorkloadPin` and compatible `EnvironmentPin`. The baseline is remeasured for
each comparison. A historical record may trigger investigation but cannot by
itself prove a new candidate's improvement.

The scheduler supports:

- randomized baseline/candidate pairs as the default;
- ABBA ordering for short deterministic workloads;
- fixed ordering only when a workload explicitly documents why order cannot
  affect it.

Randomized ordering and repeated baseline samples reduce cache, thermal,
background-load, and infrastructure-drift bias. The randomization seed is
stored.

### 8.3 Statistical result

For every primary metric the comparison reports:

- baseline and candidate summaries;
- absolute and relative effect;
- a paired bootstrap confidence interval;
- declared practical threshold;
- sample count and dispersion;
- `improved`, `regressed`, `equivalent`, or `inconclusive`.

`p95` and `p99` are allowed only when the sample count and sampling method can
support them; otherwise the report marks them unavailable. The first release
defaults to median wall-clock latency and may add CPU time, peak RSS,
allocations, I/O operations, query count, or throughput when an adapter can
collect them reliably.

Overall selection is eligible only when:

1. every required behavioral and integrity gate passes;
2. the primary metric is valid and exceeds the practical threshold in the
   desired direction;
3. its confidence interval satisfies the configured decision rule;
4. no protected secondary metric regresses beyond its threshold;
5. workload, revision, and environment pins pass compatibility checks.

Ambiguous evidence yields `inconclusive`, not a win.

### 8.4 Diagnostic snapshots

A `PerformanceSnapshot` includes:

- the three pins and a `ProfilerSpec` digest;
- capture duration, adapter identity/version, and observed overhead when known;
- normalized hotspots with stable keys;
- raw artifact references, media types, byte sizes, and digests;
- normalization warnings and symbol-resolution quality;
- sanitization status and visibility policy.

A hotspot has a `kind` (`function`, `call-stack`, `endpoint`, `query`,
`allocation`, `lock`, `io`, or `resource`), stable key, display label, optional
source path/line, inclusive and exclusive cost, sample count, percentage, and
confidence/quality metadata. Adapter-specific fields remain namespaced in an
extension object and cannot be required by generic selection logic.

## 9. Profiler adapter contract

The first-class port is intentionally narrow:

```python
class ProfilerAdapter(Protocol):
    @property
    def descriptor(self) -> ProfilerDescriptor: ...

    def check_capabilities(
        self, environment: EnvironmentPin
    ) -> CapabilityReport: ...

    def prepare(self, spec: ProfilerSpec, workspace: Path) -> PreparedCapture: ...

    def capture(
        self,
        prepared: PreparedCapture,
        invocation: WorkloadInvocation,
        limits: ResourceLimits,
    ) -> RawProfileArtifact: ...

    def normalize(
        self, artifact: RawProfileArtifact, symbols: SymbolMap
    ) -> tuple[Hotspot, ...]: ...
```

The abox-facing `ProfilerRunner` owns isolation, timeouts, output collection,
and artifact digesting. Adapters cannot select sandbox profiles, enable host
access, widen network policy, or choose unbounded output paths.

Initial adapters:

1. `SyntheticProfilerAdapter`, test-only, producing deterministic hotspots.
2. A Python sampling adapter, chosen after an abox capability spike between
   `py-spy` and an in-process `cProfile` fallback. Sampling is preferred because
   it perturbs call behavior less.
3. A system resource sampler for wall/CPU/RSS/I/O metrics that needs no
   language-specific symbols.

`bakudo doctor` reports each adapter as available, unavailable, or degraded,
with an actionable reason. Lack of an optional profiler never weakens the
independent uninstrumented verification path.

## 10. Experiment and optimization integration

### 10.1 One experiment system

Performance work does not introduce a parallel `Benchmark`, `Study`, or
promotion abstraction. `ExperimentSpec` eventually gains a discriminated
subject:

```text
subject.kind = agent-spec        # current task-backed experiment
subject.kind = software-artifact # revision + workload-backed experiment
```

The shared experiment layer owns design, repetitions, paired scheduling,
statistics, result reporting, and evidence lineage. Subject bindings own how an
episode is provisioned and measured.

`MeasurementRecord` remains a base performance primitive rather than forcing a
no-agent capture into `TrialRecord`. A software-artifact trial references its
measurement record IDs. This permits repository observation and manual capture
before the full artifact experiment binding exists.

### 10.2 Optimize loop

The current free-form `Objective.constraints.benchCommand` and agent-reported
`bench_seconds_before/after` are temporary. They are replaced, without legacy
aliases, by a structured performance contract containing a `workloadRef`,
primary metric, and decision policy.

The optimized flow becomes:

1. Load and pin the workload from the baseline before candidate mutation.
2. Capture an optional baseline `PerformanceSnapshot`.
3. Give the scout only an approved sanitized hotspot summary and immutable
   evidence IDs.
4. Let each attempt modify only the target repository code.
5. Run behavior/safety/integrity verification on a fresh candidate tree.
6. Remeasure baseline and candidate, profiler disabled, with paired ordering.
7. Create a `PerformanceComparison` and select only an eligible improvement.
8. Optionally capture the winning candidate to explain hotspot movement; this
   explanation cannot reverse the measurement verdict.

Agent-supplied timing fields are removed from selection inputs. An agent may
describe expected performance effects in its report, but those claims are
untrusted explanatory text.

## 11. Curriculum integration

`RepoSignals` gains typed `PerformanceRegressionSignal` values. A performance
collector reads only approved, valid records/comparisons and produces a signal
when all configured conditions hold:

- the practical regression threshold is crossed;
- minimum valid sample and confidence requirements are met;
- the workload is approved for autonomous use;
- the regression occurs in the configured observation window or for the
  configured number of consecutive captures;
- no active objective already owns the same deduplication key;
- a cooldown has elapsed since a prior failed/no-change optimization.

The stable deduplication key includes repository, workload pin, primary metric,
baseline policy/window, and the top normalized hotspot key when available.

Priority incorporates effect size, recurrence, workload criticality, confidence,
estimated resource cost, and user-visible impact. Hotspot paths are advisory
`targetPaths`, not an instruction to modify them. The created `optimize`
objective pins its evidence and workload and cannot be silently retargeted if a
new capture appears.

Hysteresis prevents objective churn: a regression threshold creates work, a
stricter recovery threshold clears it, and repeated inconclusive results extend
the cooldown rather than spawning duplicates.

## 12. Persistence and artifact retention

Postgres remains the authoritative metadata ledger. Proposed append-oriented
tables:

- `workload_versions` — canonical workload metadata and pins;
- `measurement_records` — invocation outcome and metric summaries;
- `metric_sample_sets` — bounded raw numeric samples or artifact references;
- `performance_snapshots` — normalized capture metadata;
- `performance_hotspots` — queryable normalized hotspots;
- `performance_comparisons` — paired effects, verdict, and integrity;
- `performance_artifacts` — URI, digest, media type, byte size, visibility,
  and retention class.

Large raw profiles are stored through `ArtifactStore` under a content digest.
The initial development adapter may use a local directory; production uses an
object store. The ledger must not contain opaque megabyte-scale profiler blobs.

All create operations have stable idempotency keys so Temporal activity retries
cannot duplicate records. Records are immutable; a superseding analysis creates
a new comparison with lineage to the earlier one. Retention may delete raw
artifacts after policy expiry, but must preserve their digests, normalized
summaries, comparison result, and deletion audit event.

## 13. CLI and API

The CLI is optimized for discovery, scripting, and precise failure messages:

```text
bakudo workload list [--source PATH] [--json]
bakudo workload validate PATH [--json]
bakudo workload inspect NAME [--source PATH] [--json]

bakudo performance measure --repo REPO --workload NAME --ref REF [--json]
bakudo performance capture --repo REPO --workload NAME --ref REF --profiler NAME [--json]
bakudo performance compare --repo REPO --workload NAME --baseline-ref REF --candidate-ref REF [--json]
bakudo performance show RECORD_ID [--json]
bakudo performance regressions [--repo REPO] [--json]
```

Rules:

- `measure` records uninstrumented samples for one revision. It is the manual
  baseline/observation primitive.
- `capture` requires a profiler and records diagnostic data. Its duration is
  never eligible for a comparison.
- `compare` is the proof-producing path and never enables a profiler for timed
  repetitions; it orchestrates fresh baseline and candidate measurements.
- validation errors carry JSON-pointer paths and remediation hints.
- JSON output uses stable tagged records; progress goes to stderr.
- the synchronous CLI and Temporal/API paths invoke the same implementation
  functions, matching the current pipeline pattern.

API resources mirror the domain rather than shell commands:

- `POST /performance/measurements`
- `POST /performance/captures`
- `POST /performance/comparisons`
- `GET /performance/records/{id}`
- `GET /performance/regressions`
- `GET /workloads` and `POST /workloads/validate`

Long-running create routes return workflow/operation IDs. Status reads are
idempotent. Authorization distinguishes viewing summaries from downloading raw
profile artifacts.

## 14. Bakudo self-observability

Bakudo adds a small span API that can emit OpenTelemetry when configured and a
no-op implementation otherwise. Stable span names include:

- `bakudo.queue.wait`
- `bakudo.bundle.render`
- `bakudo.sandbox.prepare`
- `bakudo.model.first_token`
- `bakudo.model.generate`
- `bakudo.tool.execute`
- `bakudo.report.extract`
- `bakudo.verifier.run`
- `bakudo.performance.measure`
- `bakudo.statistics.analyze`
- `bakudo.ledger.persist`

Allowed attributes are IDs, role, phase, status, adapter, workload name/version,
model identifier, and bounded numeric counts. Repository contents, prompts,
commands containing secrets, environment values, tool arguments/results, and
raw errors are excluded or scrubbed.

The initial operational report answers:

- where elapsed time is spent by phase;
- queue, sandbox-start, first-token, verification, and total p50/p95 latency;
- error and timeout rate per phase;
- throughput and saturation by worker/profile;
- change from a pinned release or rolling baseline.

Self-observability data creates operator alerts first. Turning a Bakudo internal
regression into an autonomous self-modification objective is a later policy
decision and must not be enabled implicitly.

## 15. Security and integrity invariants

1. Workloads, datasets, measurement plans, profilers, comparison rules, and
   behavioral verifiers are trusted measurement-plane inputs pinned before a
   candidate runs.
2. Repository code executes only in abox. Profiling cannot trigger host
   execution or broaden sandbox privileges.
3. Candidate diffs touching pinned measurement inputs fail integrity checks.
4. Agents receive sanitized normalized summaries, never privileged workload
   internals or raw artifacts by default.
5. Raw profiles are secret-scanned, access-controlled, size-bounded, and
   retained by policy because symbols, paths, endpoints, queries, and values
   may disclose sensitive information.
6. Network access is `none` unless a workload's reviewed environment explicitly
   requires a scoped endpoint.
7. Profiler failure is explicit. It cannot be interpreted as “no hotspot” or
   cause an unprofiled candidate to win.
8. Comparison uses uninstrumented data produced outside the candidate's
   mutable surface. Agent-reported performance is never authoritative.
9. Production traffic or production profiling requires separate human-approved
   ingestion, privacy, and retention policy; it is off by default.
10. A performance win cannot override behavioral, safety, scope, or integrity
    failure.

## 16. Failure semantics

Expected terminal states are explicit and machine-readable:

- `completed` — requested evidence is valid and persisted;
- `inconclusive` — execution succeeded but evidence cannot support a verdict;
- `unsupported` — requested adapter/capability is unavailable;
- `invalid-workload` — manifest or input integrity failed;
- `incompatible-environment` — comparison pins cannot be matched;
- `timed-out` — measurement/capture exceeded its bound;
- `failed` — infrastructure, workload, adapter, normalization, or persistence
  failed with a typed reason;
- `cancelled` — operator/workflow cancellation completed cleanup.

Partial artifacts may be retained for diagnosis but are marked incomplete and
cannot feed curriculum or selection. Retrying an idempotent operation either
returns the existing valid record or creates a new explicitly linked attempt;
it never overwrites evidence.

## 17. Acceptance criteria for the substrate

The first production-capable slice is complete when:

1. A packaged smoke workload can be loaded, pinned, measured, captured with a
   deterministic adapter, compared, persisted, and displayed through CLI and
   API using both synchronous and Temporal paths.
2. The same inputs produce stable canonical digests and deterministic test
   schedules.
3. An intentionally faster fixture wins only under uninstrumented independent
   comparison; an agent claim or profiled timing cannot affect the verdict.
4. Invalid samples, incompatible pins, tampered workloads, protected metric
   regressions, and behavior failures all fail closed.
5. A valid repeated regression produces one deduplicated optimize objective;
   inconclusive/noisy captures produce none.
6. In-memory and Postgres ledgers have contract parity, including retry
   idempotency.
7. `bakudo doctor` explains profiler and artifact-store readiness.
8. Phase-level Bakudo latency can be exported without recording sensitive
   payloads.
9. Unit tests can exercise models, sources, scheduling, normalization,
   comparison, regression creation, and objective generation independently,
   without abox, Temporal, Postgres, or a profiler installed.
10. Live tests demonstrate real abox capture and uninstrumented comparison on
    the selected first language adapter.

## 18. Deferred decisions

These choices should be made from evidence during the implementation spikes,
not guessed in the schema:

- first production profiler (`py-spy` versus `cProfile` fallback) under current
  abox capabilities;
- production object-store implementation and retention durations;
- minimum sample policy for tail percentiles by workload class;
- whether artifact experiments should extend `TrialRecord` directly or add a
  generic experiment-observation envelope after `MeasurementRecord` is proven;
- which telemetry backend and collector topology production deployments use;
- whether approved external production traces can seed regression signals;
- the operational threshold at which a runner or normalizer deserves its own
  deployed service.

None of these deferrals blocks the pure contracts, independent measurement
rule, workload pinning, or first deterministic vertical slice.
