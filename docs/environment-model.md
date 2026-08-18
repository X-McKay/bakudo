# Environment model and terminology

Bakudo models an agent evaluation as a partially observable interaction with a
controlled software environment. The vocabulary is deliberately close to a
partially observable Markov decision process (POMDP), while stopping short of
claiming that Bakudo is a general POMDP solver.

## Formal correspondence

A POMDP is commonly written as `(S, A, T, Ω, O, R, γ)`. Bakudo's current
correspondence is:

| Formal term | Bakudo representation |
|---|---|
| State `S` | Repository contents, process state, clocks, tool state, and sandbox state during an episode |
| Action `A` | A policy's permitted tool calls and final response |
| Transition `T` | Tool execution and sandbox behavior that move the environment to its next state |
| Observation `Ω`, `O` | The initial `TaskInstruction`, repository-visible data, and subsequent tool results exposed to the policy |
| Reward `R` | The independently computed verifier outcome, including fail-to-pass and pass-to-pass rates |
| Horizon / discount `γ` | Currently expressed as finite `ResourceLimits`; Bakudo does not yet optimize an explicit discount factor |

The environment is partially observable because the policy sees only its
instruction, workspace, and tool results. Privileged verifier inputs,
reference solutions, and control-plane state are not observations available to
the policy.

`AgentSpec` parameterizes the policy: model, prompt, tools, skills, network
posture, and policy-side budgets. The effective episode limits are the stricter
intersection of the `AgentSpec` limits and the task's `ResourceLimits`.

## Canonical Bakudo terms

| Term | Meaning |
|---|---|
| `TaskSpec` | Versioned definition of an evaluation environment: instruction, environment, limits, verifier, hard constraints, and metadata |
| `TaskInstruction` | Initial observation presented to the policy; it describes the work and success criteria without exposing the solution |
| `EnvironmentSpec` | Execution profile and network posture for the environment |
| `ResourceLimits` | Finite episode ceilings for wall time, tool calls, and tokens |
| `VerifierSpec` | Privileged definition of independent reward evaluation and negative controls |
| `ConstraintSpec` | Hard validity rules evaluated separately from reward, such as permitted change paths |
| `TaskSource` | Port that resolves versioned tasks independently of their storage or transport |
| `LoadedTask` | Validated `TaskSpec`, local materialization path, and immutable `TaskPin` |
| `TaskPin` | Exact provenance: source URI, corpus revision, task name/version, bundle digest, and verifier digest |
| Episode | One actual interaction trajectory for an agent, task, and seed |
| `RunRecord` | Operational execution record used for generic worker lifecycle and telemetry |
| `TrialRecord` | Experimental record of one policy episode, including its `episode_id`, `TaskPin`, metrics, reward/evaluation, and integrity results |
| `ExperimentSpec` | A deterministic paired design whose explicit subject is either `agent-spec` or `software-artifact` |
| `ExperimentObservation` | Subject-neutral named metrics plus typed evidence: an embedded `TrialRecord` for agent subjects or a persisted `MeasurementRecord` ID for artifact subjects |
| `AgentRunBundle` | Per-run worker payload containing an objective, `AgentSpec`, memory excerpts, and effective budget; it is not a published task bundle |
| Published task bundle | Immutable, content-addressed artifact containing one complete task and its `BundleManifest` |

An `Objective` is a general Bakudo work item. A `TaskInstruction` is the
benchmark-specific initial observation from which a trial objective is
derived. They remain separate because ordinary runs need not be part of an
experiment.

## Canonical performance-evidence terms

Target-repository performance uses a parallel but distinct evidence family:

| Term | Meaning |
|---|---|
| `WorkloadSpec` | Versioned, shell-free target-code exercise: subject repository, command, environment requirements, measurement plan, metrics, and optional profilers |
| `WorkloadSource` | Storage-neutral port resolving a directory corpus or immutable workload bundle |
| `LoadedWorkload` | Validated immutable workload materialization plus provenance and `WorkloadPin` |
| `WorkloadPin` | Exact source URI/kind, collection revision, workload name/version, manifest, dataset, executor, and bundle digests |
| `RevisionPin` | Exact repository source, commit/tree identity, cleanliness, and optional base/patch digest |
| `EnvironmentPin` | Exact Bakudo/abox/image/runtime/dependency, hardware, OS, and optional profiler identity |
| `MeasurementPlan` | Warmups, repetitions, timeout, deterministic schedule, and declared `MetricDefinition` values |
| `MeasurementRecord` | Raw evidence from one revision under one workload/environment/plan. Samples are uninstrumented; warmups never enter summaries |
| Diagnostic capture | One profiler-enabled execution used to attribute cost or find hotspots; it is not a measurement |
| `PerformanceSnapshot` | Diagnostic evidence: profiler identity, normalized hotspots, warnings, restricted raw artifacts, and capture duration |
| `PerformanceComparison` | Derived paired analysis of baseline/candidate `MeasurementRecord` values, including effects, confidence intervals, compatibility/integrity, verdict, and eligibility |
| `PerformanceRegressionSignal` | Deduplicated, policy-approved repeated regression evidence derived only from persisted comparisons |
| `ArtifactRef` | Content-addressed URI/digest/size/media metadata for bounded raw diagnostic output |

A task asks, “Did this policy solve the controlled problem?” A workload asks,
“How did this pinned revision perform under this pinned execution contract?” A
`RunRecord` reports operational lifecycle. A `TrialRecord`,
`MeasurementRecord`, and `PerformanceSnapshot` are therefore not aliases and
must not be substituted for one another.

Use *measure* only for uninstrumented target evidence, *capture* for
instrumented diagnostics, and *compare* for derived statistical evidence. A
named environment *profile* is configuration. The legacy command phrase
`experiment profile` has one narrow meaning: candidate-free behavioral
characterization of an agent across tasks. It does not run a profiler or
produce a `PerformanceSnapshot`. Agent-reported timing and
`PerformanceSnapshot.captureSeconds` may guide investigation, but neither can
establish improvement or regression.

## Reward, constraints, and integrity

Reward and validity are intentionally separate:

- The verifier computes task performance from privileged inputs.
- Constraints determine whether the episode respected the evaluation
  protocol.
- `TrialRecord.integrity` records verifier-input, denied-action, scope, and
  change-limit violations.
- Experiment hard gates can reject a candidate regardless of reward when
  integrity is violated.

This avoids treating a weighted score as permission to violate a hard rule.
Negative controls are plausible but incorrect patches that the verifier must
reject; reference solutions demonstrate solvability and are never policy
observations.

## Current limits of the model

Bakudo does not yet implement a learned transition model, explicit belief-state
estimator, online policy training, or a generic environment-service protocol.
Memory excerpts are retrieved evidence, not a formal belief state. The
POMDP-aligned contracts provide a stable foundation for those additions
without pretending they already exist.

An external environment framework such as NeMo Gym can integrate at the
existing ports: task discovery/materialization behind `TaskSource`, execution
behind the sandbox/pipeline boundary, and independent grading behind
`VerifierRunner`. Remote target-performance execution can instead implement
`MeasurementRunner`/`WorkloadInvoker` or `ProfilerRunner`, while preserving the
same workload, revision, environment, record, and artifact contracts. A remote
adapter should not introduce a second experiment or evidence vocabulary.

## Isolated improvement boundaries

The main components can be evaluated independently:

| Component | Contract test |
|---|---|
| Schema/model | Parse and reject fixtures without loading a corpus or running an agent |
| Task source | Resolve/filter tasks and compute pins without provisioning an episode |
| Bundle publisher/loader | Deterministic publication, round trip, and tamper detection |
| Provisioner | Materialize byte-identical workspaces for the same task and seed |
| Verifier runner | Execute a command and return a transport-neutral `VerificationResult` |
| Verifier protocol | Test pristine/reference/negative-control behavior with a stub or local runner |
| Trial runner | Exercise one episode with stubbed policy and verifier ports |
| Statistics | Analyze synthetic `TrialRecord` series without any runtime services |
| Orchestration | Test synchronous or Temporal coordination with activity boundaries stubbed |
| Workload source/bundle | Discover, pin, round-trip, and reject tampering without running target code |
| Measurement scheduling/samples | Test ordering, warmup exclusion, units, missing/non-finite samples, and summaries as pure functions |
| Measurement service | Inject a fake `WorkloadInvoker` and in-memory ledger; test one revision or paired interleaving without abox |
| Comparison/statistics | Recompute deterministic paired bootstrap evidence from synthetic raw samples without a runner or database |
| Profiler adapter/normalizer | Test capability, argv construction, bounds, hostile output, and stable hotspot keys without orchestration |
| Artifact store | Contract-test content addressing, atomic/idempotent puts, byte limits, and integrity without profiling |
| Regression policy | Reduce persisted comparison fixtures through confidence, recurrence, cooldown, and deduplication without running workloads |
| Performance orchestration | Inject source/invoker/capture/ledger fakes; test retry-stable IDs and typed terminal states without external services |
| Experiment subject binding | Inject TrialRecord or MeasurementRecord providers and test one shared direction-aware analysis/reporting path |
| Self-observability | Record fake monotonic spans and summarize phase attribution without exporting telemetry |

These boundaries are ordinary in-process ports today. They can become remote
services later without changing the domain vocabulary or persistence shape.
