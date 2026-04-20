import assert from "node:assert/strict";
import test from "node:test";

import { createMergeController } from "../../src/host/mergeController.js";

test("mergePreservedCandidate dispatches abox merge for candidate task id", async () => {
  const calls: Array<{ file: string; args: string[] }> = [];
  const controller = createMergeController(async (file, args) => {
    calls.push({ file, args });
    return {};
  });
  await controller.mergePreservedCandidate("abox", "/repo", {
    candidateId: "candidate-1",
    taskId: "task-preserved-1",
  });
  assert.deepEqual(calls, [
    {
      file: "abox",
      args: ["merge", "--repo", "/repo", "task-preserved-1"],
    },
  ]);
});

test("discardPreservedCandidate dispatches abox stop --clean for candidate task id", async () => {
  const calls: Array<{ file: string; args: string[] }> = [];
  const controller = createMergeController(async (file, args) => {
    calls.push({ file, args });
    return {};
  });
  await controller.discardPreservedCandidate("abox", "/repo", {
    candidateId: "candidate-1",
    taskId: "task-preserved-1",
  });
  assert.deepEqual(calls, [
    {
      file: "abox",
      args: ["stop", "--repo", "/repo", "task-preserved-1", "--clean"],
    },
  ]);
});
