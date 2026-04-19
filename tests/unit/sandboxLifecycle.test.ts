import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAboxRunArgs,
  generateSandboxTaskId,
  isEphemeralSandbox,
} from "../../src/host/sandboxLifecycle.js";

const preserved = {
  agentBackend: "codex exec --dangerously-bypass-approvals-and-sandbox",
  sandboxLifecycle: "preserved" as const,
  mergeStrategy: "interactive" as const,
};

const ephemeral = {
  ...preserved,
  sandboxLifecycle: "ephemeral" as const,
  mergeStrategy: "none" as const,
};

test("generateSandboxTaskId sanitizes and prefixes attempt id", () => {
  assert.equal(generateSandboxTaskId("attempt/1"), "bakudo-attempt-1");
  assert.equal(generateSandboxTaskId(""), "bakudo-attempt");
});

test("isEphemeralSandbox respects profile lifecycle", () => {
  assert.equal(isEphemeralSandbox(preserved), false);
  assert.equal(isEphemeralSandbox(ephemeral), true);
  assert.equal(isEphemeralSandbox(undefined), true);
});

test("buildAboxRunArgs includes --ephemeral only when profile is ephemeral", () => {
  assert.deepEqual(buildAboxRunArgs("bakudo-a1", ephemeral, "/repo"), [
    "--repo",
    "/repo",
    "run",
    "--task",
    "bakudo-a1",
    "--ephemeral",
  ]);
  assert.deepEqual(buildAboxRunArgs("bakudo-a1", preserved, "/repo"), [
    "--repo",
    "/repo",
    "run",
    "--task",
    "bakudo-a1",
  ]);
});
