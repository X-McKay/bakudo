import assert from "node:assert/strict";
import test from "node:test";

import { reconcileFile, reconcileFiles } from "../../src/host/reconcileFiles.js";

test("reconcileFile resolves candidate-only and source-only changes deterministically", async () => {
  assert.deepEqual(
    await reconcileFile({
      path: "src/a.txt",
      baseContent: "base\n",
      candidateContent: "candidate\n",
      sourceContent: "base\n",
    }),
    {
      kind: "resolved",
      path: "src/a.txt",
      resolution: "take_candidate",
      content: "candidate\n",
    },
  );

  assert.deepEqual(
    await reconcileFile({
      path: "src/b.txt",
      baseContent: "base\n",
      candidateContent: "base\n",
      sourceContent: "source\n",
    }),
    {
      kind: "resolved",
      path: "src/b.txt",
      resolution: "keep_source",
      content: "source\n",
    },
  );
});

test("reconcileFile reports unchanged and converged outcomes", async () => {
  assert.deepEqual(
    await reconcileFile({
      path: "same.txt",
      baseContent: "same\n",
      candidateContent: "same\n",
      sourceContent: "same\n",
    }),
    {
      kind: "resolved",
      path: "same.txt",
      resolution: "unchanged",
      content: "same\n",
    },
  );

  assert.deepEqual(
    await reconcileFile({
      path: "delete.txt",
      baseContent: "base\n",
      candidateContent: null,
      sourceContent: null,
    }),
    {
      kind: "resolved",
      path: "delete.txt",
      resolution: "converged",
      content: null,
    },
  );
});

test("reconcileFile merges non-overlapping text edits", async () => {
  assert.deepEqual(
    await reconcileFile({
      path: "mergeable.txt",
      baseContent: "alpha\nbeta\ngamma\ndelta\nepsilon\n",
      candidateContent: "alpha\nbeta candidate\ngamma\ndelta\nepsilon\n",
      sourceContent: "alpha\nbeta\ngamma\ndelta\nepsilon source\n",
    }),
    {
      kind: "resolved",
      path: "mergeable.txt",
      resolution: "merge_text",
      content: "alpha\nbeta candidate\ngamma\ndelta\nepsilon source\n",
    },
  );
});

test("reconcileFile surfaces classified conflicts", async () => {
  assert.deepEqual(
    await reconcileFile({
      path: "conflict.txt",
      baseContent: "base\n",
      candidateContent: "candidate\n",
      sourceContent: "source\n",
    }),
    {
      kind: "conflict",
      path: "conflict.txt",
      conflictKind: "both_modified_different",
      classification: {
        class: "textual_overlap",
        decision: "needs_confirmation",
        reason: "textual overlap requires confirmation for conflict.txt",
      },
      baseContent: "base\n",
      candidateContent: "candidate\n",
      sourceContent: "source\n",
    },
  );
});

test("reconcileFiles returns stable path ordering for resolved files and conflicts", async () => {
  const summary = await reconcileFiles([
    {
      path: "z-conflict.txt",
      baseContent: null,
      candidateContent: "candidate\n",
      sourceContent: "source\n",
    },
    {
      path: "a-resolved.txt",
      baseContent: "base\n",
      candidateContent: "candidate\n",
      sourceContent: "base\n",
    },
    {
      path: "m-resolved.txt",
      baseContent: "base\n",
      candidateContent: "base\n",
      sourceContent: "source\n",
    },
  ]);

  assert.deepEqual(summary.resolved, [
    {
      kind: "resolved",
      path: "a-resolved.txt",
      resolution: "take_candidate",
      content: "candidate\n",
    },
    {
      kind: "resolved",
      path: "m-resolved.txt",
      resolution: "keep_source",
      content: "source\n",
    },
  ]);
  assert.deepEqual(summary.conflicts, [
    {
      kind: "conflict",
      path: "z-conflict.txt",
      conflictKind: "both_added_different",
      classification: {
        class: "textual_overlap",
        decision: "needs_confirmation",
        reason: "textual overlap requires confirmation for z-conflict.txt",
      },
      baseContent: null,
      candidateContent: "candidate\n",
      sourceContent: "source\n",
    },
  ]);
});
