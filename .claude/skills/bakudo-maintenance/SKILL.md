---
name: bakudo-maintenance
description: >-
  Maintains and validates the Bakudo repository. Use when changing Bakudo
  code, schemas, agent specs, tasks, tests, packaging, or documentation.
---

# Bakudo Maintenance

Work from the repository root and treat these as canonical boundaries:

- `src/bakudo/` owns reusable runtime and control-plane code.
- `smoke/tasks/` contains only two tiny public smoke tasks.
- The private `bakudo-benchmarks` repository owns the benchmark corpus and
  publishes immutable, content-addressed task bundles.
- Use the formal environment terms in `docs/environment-model.md`: policy,
  action, observation, state transition, reward, constraint, and verifier.
- Use `docs/task-corpus-and-bundles.md` for task identity and provenance.
  Historical material under `docs/superpowers/` is not an API contract.

Before editing, inspect the defining symbol, its callers, its tests, and any
schema or documentation that describes the same contract. Prefer explicit
dependencies and small, independently testable components. This project does
not require compatibility aliases for obsolete internal APIs.

Run `bakudo doctor` when setup, packaged resources, task-source behavior, or
runtime posture may be involved. Treat CLI commands as a stable developer
contract: group related resources under singular nouns (`agent`, `skill`,
`task`, `trial`, `experiment`, `repo`), offer `--json` for inspection and
automation, write diagnostics to stderr, and validate arguments before work
begins. Keep `docs/cli.md`, help text, tests, and CI smoke commands synchronized.

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

For task-substrate changes, also run the focused task, trial, experiment,
bundle, and smoke-task tests. Keep Pydantic models, JSON Schemas, packaged data,
and operator documentation synchronized. Finish by searching for retired terms
and imports, then review `git diff --check` and the complete diff.
