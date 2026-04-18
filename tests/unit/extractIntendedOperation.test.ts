import assert from "node:assert/strict";
import test from "node:test";

import type { AttemptSpec } from "../../src/attemptProtocol.js";
import { extractIntendedOperation } from "../../src/host/approvalProducer.js";

/**
 * Phase 4 PR7 — `extractIntendedOperation` pulls a (tool, argument) pair
 * from the AttemptSpec for evaluation against the permission rule set.
 * Conservative by design — assistant_job returns null so worker-mediated
 * permission requests stay a Phase 6 concern.
 */

const specBase = (overrides: Partial<AttemptSpec> = {}): AttemptSpec => ({
  schemaVersion: 3,
  sessionId: "s",
  turnId: "t",
  attemptId: "a",
  taskId: "task-1",
  intentId: "i",
  mode: "build",
  taskKind: "explicit_command",
  prompt: "cmd",
  instructions: [],
  cwd: "/tmp",
  execution: { engine: "shell", command: ["bash", "-lc", "ls"] },
  permissions: { rules: [], allowAllTools: false, noAskUser: false },
  budget: { timeoutSeconds: 60, maxOutputBytes: 10_000, heartbeatIntervalMs: 5000 },
  acceptanceChecks: [],
  artifactRequests: [],
  ...overrides,
});

test("extractIntendedOperation: assistant_job returns null (worker mediates its own perms)", () => {
  const spec = specBase({
    taskKind: "assistant_job",
    execution: { engine: "agent_cli" },
  });
  assert.equal(extractIntendedOperation(spec), null);
});

test("extractIntendedOperation: explicit_command with bash -lc extracts the inner shell arg", () => {
  const spec = specBase({
    execution: { engine: "shell", command: ["bash", "-lc", "git push origin main"] },
  });
  assert.deepEqual(extractIntendedOperation(spec), {
    tool: "shell",
    argument: "git push origin main",
  });
});

test("extractIntendedOperation: verification_check shell command also surfaces the inner arg", () => {
  const spec = specBase({
    taskKind: "verification_check",
    execution: { engine: "shell", command: ["bash", "-lc", "pnpm test"] },
  });
  assert.deepEqual(extractIntendedOperation(spec), {
    tool: "shell",
    argument: "pnpm test",
  });
});

test("extractIntendedOperation: non-bash command falls back to joined string", () => {
  const spec = specBase({
    execution: { engine: "shell", command: ["echo", "hi"] },
  });
  assert.deepEqual(extractIntendedOperation(spec), {
    tool: "shell",
    argument: "echo hi",
  });
});

test("extractIntendedOperation: empty command array returns null", () => {
  const spec = specBase({
    execution: { engine: "shell", command: [] },
  });
  assert.equal(extractIntendedOperation(spec), null);
});

test("extractIntendedOperation: missing command returns null", () => {
  const spec = specBase({
    execution: { engine: "shell" },
  });
  assert.equal(extractIntendedOperation(spec), null);
});
