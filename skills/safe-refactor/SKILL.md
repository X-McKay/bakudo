---
name: safe-refactor
description: >-
  Performs behavior-preserving refactors with a tight verify loop. Use when an
  agent restructures code without intending to change behavior.
---

# Safe Refactor

Refactors must not change observable behavior.

1. Establish a green baseline: run the relevant tests before touching anything.
   If they are red, stop and report — do not refactor on a broken base.
2. Make one small, mechanical change at a time (rename, extract, inline). Keep
   each step independently revertible.
3. Re-run the targeted tests after each step. If a step goes red, revert it.
4. Treat the objective as the compatibility boundary. Remove obsolete APIs
   when the objective calls for a clean break; otherwise keep public behavior
   stable. If `avoidPublicApiChanges` is set, treat exported symbols as frozen.
5. Keep the diff minimal and reviewable; do not reformat unrelated code.

Report the before/after test status and the list of mechanical steps taken.
