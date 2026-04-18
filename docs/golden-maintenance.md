# Golden Fixture Maintenance

Phase 6 Workstream 10 (PR15) wires the 14 canonical UX fixtures at
`plans/bakudo-ux/examples/*` into the bakudo test suite. This document
explains how to regenerate them, when regeneration is acceptable, and
how to review a golden diff.

## Where fixtures live

- Source of truth: `plans/bakudo-ux/examples/` at the parent-workspace
  level (NOT inside the bakudo git repo).
- Loaded at test time by `tests/helpers/golden.ts` via
  `locateExamplesDir()`, which walks up from the compiled test file
  until it finds `plans/bakudo-ux/examples/README.md`.
- Fourteen files enumerated in `FIXTURE_IDS`. Each has a matching
  `tests/golden/*.test.ts`.

## Fixture-byte-direction contract

Fixtures use the **literal form** `\e[1m` for reviewer readability
(`plans/bakudo-ux/examples/README.md:138-140`). The comparator decodes
literal → byte on LOAD, so canonical compare form is the raw PTY byte
stream. On mismatch the diff is re-rendered back to literal form
before being shown to reviewers.

## How to regenerate

Regeneration is **explicit only**. Two equivalent paths:

1. **Environment opt-in**
   ```bash
   BAKUDO_GOLDEN_REGENERATE=1 mise run test
   ```
   Every `tests/golden/*.test.ts` checks `regenerationRequested()` before
   writing. Normal runs never mutate fixtures.

2. **CLI wrapper**
   ```bash
   pnpm build && node dist/tests/helpers/goldenCli.js --regenerate
   ```
   The CLI accepts `--test-only` (default, no-op) and `--regenerate`
   (explicit update). There is NO automatic regeneration path.

## When regeneration is acceptable

Only in two cases:

1. **A renderer contract change.** You added or removed a section, renamed
   an envelope field, changed dialog copy, etc. The change is intentional;
   reviewers must see the full diff of each affected fixture.
2. **A fixture was wrong.** It did not match the scenario it claimed to
   represent. Document the mismatch in the commit message.

Do NOT regenerate to paper over a flaky test. A flaky golden is a bug in
the harness or in a normalizer; fix it at the source.

## How to review a golden diff

1. Check the commit message for an explicit rationale (one of the two
   cases above).
2. Confirm every fixture change is accompanied by a matching code change.
   Pure fixture changes with no code delta are a red flag.
3. Read the fixture diff in literal form (`\e[...]`). It's stable across
   terminals and is what reviewers diff in git.
4. If a section grew, confirm no existing ANSI reset (`\e[0m`) was lost.
5. Cross-check the scenario name against `tests/golden/*.test.ts`. Each
   test must still reference the same user scenario after regeneration.

## CI rule

Per plan `06-rollout-reliability-and-operability.md:738`: **do not make
PTY golden updates happen automatically in CI.** CI runs only the
test-only path. `BAKUDO_GOLDEN_REGENERATE=1` must never be set in any
CI workflow.
