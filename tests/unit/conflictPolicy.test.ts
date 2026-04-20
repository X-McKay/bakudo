import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyApplyConflict,
  classifyReconciliationConflict,
  isLockfilePath,
} from "../../src/host/conflictPolicy.js";

test("classifyReconciliationConflict returns null for auto-resolvable states", () => {
  assert.equal(
    classifyReconciliationConflict({
      baseContent: "base\n",
      candidateContent: "candidate\n",
      sourceContent: "base\n",
    }),
    null,
  );
  assert.equal(
    classifyReconciliationConflict({
      baseContent: "base\n",
      candidateContent: "same\n",
      sourceContent: "same\n",
    }),
    null,
  );
  assert.equal(
    classifyReconciliationConflict({
      baseContent: null,
      candidateContent: null,
      sourceContent: "added upstream\n",
    }),
    null,
  );
});

test("classifyReconciliationConflict classifies the supported conflict cases", () => {
  assert.equal(
    classifyReconciliationConflict({
      baseContent: null,
      candidateContent: "candidate add\n",
      sourceContent: "source add\n",
    }),
    "both_added_different",
  );
  assert.equal(
    classifyReconciliationConflict({
      baseContent: "base\n",
      candidateContent: null,
      sourceContent: "source edit\n",
    }),
    "candidate_deleted_source_modified",
  );
  assert.equal(
    classifyReconciliationConflict({
      baseContent: "base\n",
      candidateContent: "candidate edit\n",
      sourceContent: null,
    }),
    "candidate_modified_source_deleted",
  );
  assert.equal(
    classifyReconciliationConflict({
      baseContent: "base\n",
      candidateContent: "candidate edit\n",
      sourceContent: "source edit\n",
    }),
    "both_modified_different",
  );
});

test("classifyApplyConflict escalates lockfiles separately from plain text overlaps", () => {
  assert.equal(isLockfilePath("pnpm-lock.yaml"), true);
  assert.deepEqual(
    classifyApplyConflict({
      path: "src/app.ts",
      kind: "both_modified_different",
    }),
    {
      class: "textual_overlap",
      decision: "needs_confirmation",
      reason: "textual overlap requires confirmation for src/app.ts",
    },
  );
  assert.deepEqual(
    classifyApplyConflict({
      path: "pnpm-lock.yaml",
      kind: "both_modified_different",
    }),
    {
      class: "lockfile_conflict",
      decision: "needs_confirmation",
      reason: "lockfile conflict requires confirmation for pnpm-lock.yaml",
    },
  );
});
