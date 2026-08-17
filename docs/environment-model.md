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
| `TrialRecord` | Experimental measurement of one episode, including its `episode_id`, `TaskPin`, metrics, evaluation, and integrity results |
| Experiment | A deterministic matrix of baseline and candidate trials with paired statistical analysis |
| `AgentRunBundle` | Per-run worker payload containing an objective, `AgentSpec`, memory excerpts, and effective budget; it is not a published task bundle |
| Published task bundle | Immutable, content-addressed artifact containing one complete task and its `BundleManifest` |

An `Objective` is a general Bakudo work item. A `TaskInstruction` is the
benchmark-specific initial observation from which a trial objective is
derived. They remain separate because ordinary runs need not be part of an
experiment.

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
`VerifierRunner`. A future remote adapter should preserve the same `TaskPin`
and trial contracts rather than introduce a second experiment model.

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

These boundaries are ordinary in-process ports today. They can become remote
services later without changing the domain vocabulary or persistence shape.
