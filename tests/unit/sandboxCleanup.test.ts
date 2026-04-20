import assert from "node:assert/strict";
import test from "node:test";

import { createSandboxCleanupController } from "../../src/host/sandboxCleanup.js";

test("createSandboxCleanupController exposes only cleanup operations", () => {
  const controller = createSandboxCleanupController(async () => ({}));
  assert.deepEqual(Object.keys(controller), ["discardPreservedCandidate"]);
  assert.equal("mergePreservedCandidate" in controller, false);
});

test("discardPreservedCandidate dispatches abox stop --clean for candidate task id", async () => {
  const calls: Array<{ file: string; args: string[] }> = [];
  const controller = createSandboxCleanupController(async (file, args) => {
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
      args: ["--repo", "/repo", "stop", "task-preserved-1", "--clean"],
    },
  ]);
});
