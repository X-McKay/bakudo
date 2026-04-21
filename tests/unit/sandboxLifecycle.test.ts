import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAboxRunArgs,
  generateSandboxTaskId,
  isEphemeralSandbox,
} from "../../src/host/sandboxLifecycle.js";

const preserved = {
  providerId: "codex",
  resolvedCommand: ["codex", "exec", "--dangerously-bypass-approvals-and-sandbox"],
  sandboxLifecycle: "preserved" as const,
  candidatePolicy: "manual_apply" as const,
};

const ephemeral = {
  ...preserved,
  sandboxLifecycle: "ephemeral" as const,
  candidatePolicy: "discard" as const,
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

test("buildAboxRunArgs passes --memory and --cpus when set in profile (abox v0.3.0)", () => {
  const profileWithResources = {
    ...preserved,
    memoryMiB: 2048,
    cpus: 2,
  };
  assert.deepEqual(buildAboxRunArgs("bakudo-a1", profileWithResources, "/repo"), [
    "--repo",
    "/repo",
    "run",
    "--task",
    "bakudo-a1",
    "--memory",
    "2048",
    "--cpus",
    "2",
  ]);
});

test("buildAboxRunArgs omits --memory and --cpus when not set in profile", () => {
  const args = buildAboxRunArgs("bakudo-a1", preserved, "/repo");
  assert.ok(!args.includes("--memory"), "should not include --memory");
  assert.ok(!args.includes("--cpus"), "should not include --cpus");
});

test("buildAboxRunArgs passes --memory and --cpus with --ephemeral together", () => {
  const ephemeralWithResources = {
    ...ephemeral,
    memoryMiB: 1024,
    cpus: 1,
  };
  const args = buildAboxRunArgs("bakudo-a1", ephemeralWithResources, "/repo");
  assert.ok(args.includes("--ephemeral"), "should include --ephemeral");
  assert.ok(args.includes("--memory"), "should include --memory");
  assert.ok(args.includes("1024"), "should include memory value");
  assert.ok(args.includes("--cpus"), "should include --cpus");
  assert.ok(args.includes("1"), "should include cpus value");
});
