---
name: safe-refactor
description: >-
  Performs behavior-preserving refactors with a tight verify loop. Use when an
  agent restructures code without intending to change behavior.
compatibility: Requires git, repository access, and a test runner.
metadata:
  version: "1.0.0"
  owner: "meta-agent"
---

# Safe Refactor

Refactors must not change observable behavior.

1. Establish a green baseline: run the relevant tests before touching anything.
   If they are red, stop and report — do not refactor on a broken base.
2. Make one small, mechanical change at a time (rename, extract, inline). Keep
   each step independently revertible.
3. Re-run the targeted tests after each step. If a step goes red, revert it.
4. Keep the public API stable unless the objective explicitly permits changing
   it; if `avoidPublicApiChanges` is set, treat exported symbols as frozen.
5. Keep the diff minimal and reviewable; do not reformat unrelated code.

Report the before/after test status and the list of mechanical steps taken.
