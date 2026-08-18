---
name: bakudo-maintenance
description: >-
  Maintains and validates the Bakudo repository. Use when changing Bakudo
  code, schemas, agent specs, tasks, workloads, performance evidence,
  observability, tests, packaging, CLI behavior, or documentation.
---

# Bakudo Maintenance

Work from the repository root and treat these as canonical boundaries:

- `src/bakudo/` owns reusable runtime and control-plane code.
- `smoke/tasks/` contains only two tiny public smoke tasks.
- `smoke/workloads/` contains only tiny public integration workloads.
- The private `bakudo-benchmarks` repository owns the benchmark corpus and
  publishes immutable, content-addressed corpus bundles. Target-specific
  workload corpora may be versioned and published separately.
- Raw diagnostic profiles belong in the restricted artifact store, never in
  either source repository.
- Use the formal terms in `docs/environment-model.md`: policy, action,
  observation, state transition, reward, constraint, verifier, workload,
  measurement, capture, snapshot, and comparison.
- Use `docs/task-corpus-and-bundles.md` for task identity and provenance. Use
  `docs/architecture.md`, `docs/cli.md`, and `docs/operations.md` for the
  implemented workload/performance and operator contracts. Historical
  material under `docs/superpowers/` is not an API contract.

Keep evidence families distinct:

- A `TaskSpec` evaluates a policy; a `TrialRecord` is one episode.
- A `WorkloadSpec` exercises pinned target code; a `MeasurementRecord` holds
  uninstrumented samples.
- A diagnostic capture produces a `PerformanceSnapshot` and restricted
  artifacts. It identifies hotspots but cannot prove improvement.
- A `PerformanceComparison` recomputes statistical evidence from raw samples.
  Agent-reported or profiler-observed timing never enters a promotion or
  optimization evidence gate.
- `ExperimentSpec.subject` is explicitly `agent-spec` or `software-artifact`.
  Agent observations embed `TrialRecord` evidence; artifact observations carry
  only persisted `MeasurementRecord` IDs. `experiment profile` is agent-only
  behavioral characterization and is not diagnostic profiler capture.
- `WorkloadPin`, `RevisionPin`, `EnvironmentPin`, artifact digests, and
  integrity results are immutable evidence, not optional annotations.

Before editing, inspect the defining symbol, its callers, its tests, and any
schema or documentation that describes the same contract. Prefer explicit
dependencies and small, independently testable components. This project does
not require compatibility aliases for obsolete internal APIs. When changing a
record, update its Pydantic model, JSON Schema, loaders, ledger backend,
Temporal serialization boundary, CLI/API representation, and tests together.

Run `bakudo doctor` when setup, packaged resources, task/workload-source
behavior, artifact storage, or runtime posture may be involved. Treat CLI
commands as a stable developer contract: group related resources under
singular nouns (`agent`, `skill`, `task`, `workload`, `performance`, `trial`,
`experiment`, `repo`), offer `--json` for inspection and automation, write
diagnostics to stderr, and validate arguments before work begins. Verify every
documented example against `bakudo GROUP COMMAND --help`. Keep `docs/cli.md`,
help text, tests, and CI smoke commands synchronized.

Select focused tests first. The packaged helper can suggest candidates from a
diff:

```bash
git diff | python skills/test-selection/scripts/select_tests.py --diff -
```

Then run the complete local gate from the active environment:

```bash
make doctor
make check
```

Install `.[all,dev]` when the environment lacks optional imports. The default
suite does not require live Postgres, FalkorDB, abox, vLLM, or Temporal
services; explicitly named live tests remain opt-in through environment
configuration.

For task-substrate changes, also run focused task, trial, experiment, bundle,
and smoke-task tests. For workload/performance changes, exercise the smallest
relevant boundaries independently: models/schema and pins; source and bundle
integrity; scheduling and sample validation; service and comparison; profiler
and artifact stores; regression policy; ledger persistence; Temporal
workflows; CLI/API dispatch; and self-observability. Prefer injected fakes and
in-memory stores for default tests; use live Temporal, Postgres, abox, and
profilers only in explicitly configured integration tests.

Keep Pydantic models, JSON Schemas, packaged data, immutable provenance, and
operator documentation synchronized. Finish by searching source, tests,
schemas, skills, and canonical docs for retired terms/imports, then review
`git diff --check` and the complete diff. Do not treat historical design and
review records as current contracts.
