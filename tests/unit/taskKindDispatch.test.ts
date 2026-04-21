import assert from "node:assert/strict";
import test from "node:test";

import type { AttemptSpec } from "../../src/attemptProtocol.js";
import { runExplicitCommand } from "../../src/worker/commandRunner.js";
import { runVerificationCheck } from "../../src/worker/checkRunner.js";
import { runAssistantJob } from "../../src/worker/assistantJobRunner.js";
import { dispatchTaskKind } from "../../src/worker/taskKinds.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const baseSpec = (overrides: Partial<AttemptSpec> = {}): AttemptSpec => ({
  schemaVersion: 3,
  sessionId: "session-1",
  turnId: "turn-1",
  attemptId: "attempt-1",
  taskId: "task-1",
  intentId: "intent-1",
  mode: "build",
  taskKind: "explicit_command",
  prompt: "run tests",
  instructions: [],
  cwd: "/tmp",
  execution: { engine: "shell", command: ["echo", "hello"] },
  permissions: { rules: [], allowAllTools: false, noAskUser: false },
  budget: { timeoutSeconds: 120, maxOutputBytes: 262144, heartbeatIntervalMs: 5000 },
  acceptanceChecks: [],
  artifactRequests: [],
  ...overrides,
});

const profile = {
  providerId: "codex",
  resolvedCommand: ["codex", "exec", "--dangerously-bypass-approvals-and-sandbox"],
  sandboxLifecycle: "preserved" as const,
  candidatePolicy: "manual_apply" as const,
};

// ---------------------------------------------------------------------------
// explicit_command
// ---------------------------------------------------------------------------

test("commandRunner: returns spec.execution.command directly", () => {
  const spec = baseSpec({
    taskKind: "explicit_command",
    execution: { engine: "shell", command: ["npm", "test"] },
  });
  const result = runExplicitCommand(spec, profile);
  assert.deepEqual(result.command, ["npm", "test"]);
});

test("commandRunner: returns false command when spec.execution.command is missing", () => {
  const spec = baseSpec({
    taskKind: "explicit_command",
    execution: { engine: "shell" },
  });
  const result = runExplicitCommand(spec, profile);
  assert.deepEqual(result.command, ["false"]);
});

test("commandRunner: returns false command when spec.execution.command is empty", () => {
  const spec = baseSpec({
    taskKind: "explicit_command",
    execution: { engine: "shell", command: [] },
  });
  const result = runExplicitCommand(spec, profile);
  assert.deepEqual(result.command, ["false"]);
});

// ---------------------------------------------------------------------------
// verification_check
// ---------------------------------------------------------------------------

test("checkRunner: joins acceptance check commands with && in bash -lc", () => {
  const spec = baseSpec({
    taskKind: "verification_check",
    execution: { engine: "shell" },
    acceptanceChecks: [
      { checkId: "c1", label: "lint", command: ["npm", "run", "lint"] },
      { checkId: "c2", label: "test", command: ["npm", "test"] },
    ],
  });
  const result = runVerificationCheck(spec, profile);
  assert.equal(result.command[0], "bash");
  assert.equal(result.command[1], "-lc");
  assert.ok(result.command[2]?.includes("&&"), "expected && between commands");
  assert.ok(result.command[2]?.includes("npm"), "expected npm in joined command");
});

test("checkRunner: prefers spec.execution.command when provided", () => {
  const spec = baseSpec({
    taskKind: "verification_check",
    execution: { engine: "shell", command: ["pnpm", "test:unit"] },
    acceptanceChecks: [{ checkId: "c1", label: "ignored", command: ["echo", "ignored"] }],
  });
  const result = runVerificationCheck(spec, profile);
  assert.deepEqual(result.command, ["pnpm", "test:unit"]);
});

test("checkRunner: skips checks without a command", () => {
  const spec = baseSpec({
    taskKind: "verification_check",
    execution: { engine: "shell" },
    acceptanceChecks: [
      { checkId: "c1", label: "manual", assertExitZero: true },
      { checkId: "c2", label: "auto", command: ["echo", "ok"] },
    ],
  });
  const result = runVerificationCheck(spec, profile);
  assert.equal(result.command[0], "bash");
  assert.ok(!result.command[2]?.includes("manual"));
});

test("checkRunner: returns echo when no checks have commands", () => {
  const spec = baseSpec({
    taskKind: "verification_check",
    execution: { engine: "shell" },
    acceptanceChecks: [{ checkId: "c1", label: "manual" }],
  });
  const result = runVerificationCheck(spec, profile);
  assert.deepEqual(result.command, ["echo", "no acceptance checks defined"]);
});

// ---------------------------------------------------------------------------
// assistant_job
// ---------------------------------------------------------------------------

test("assistantJobRunner: builds backend command from profile and uses stdin for prompt", () => {
  const spec = baseSpec({
    taskKind: "assistant_job",
    execution: { engine: "agent_cli" },
    prompt: "implement the feature",
    instructions: ["follow the style guide"],
    permissions: { rules: [], allowAllTools: false, noAskUser: false },
  });
  const result = runAssistantJob(spec, profile);
  assert.equal(result.command[0], "codex");
  assert.ok(result.stdin?.includes("implement the feature"));
  assert.ok(result.stdin?.includes("follow the style guide"));
  assert.equal(result.env?.BAKUDO_GUEST_OUTPUT_DIR, "/workspace/.bakudo/out/attempt-1");
});

test("assistantJobRunner: adds --dangerously-skip-permissions when allowAllTools", () => {
  const spec = baseSpec({
    taskKind: "assistant_job",
    execution: { engine: "agent_cli" },
    permissions: { rules: [], allowAllTools: true, noAskUser: false },
  });
  const result = runAssistantJob(spec, profile);
  assert.equal(result.command[0], "codex");
});

test("assistantJobRunner: joins prompt and instructions with double newlines", () => {
  const spec = baseSpec({
    taskKind: "assistant_job",
    execution: { engine: "agent_cli" },
    prompt: "do the thing",
    instructions: ["rule one", "rule two"],
  });
  const result = runAssistantJob(spec, profile);
  assert.equal(result.stdin, "do the thing\n\nrule one\n\nrule two");
});

// ---------------------------------------------------------------------------
// Dispatch map
// ---------------------------------------------------------------------------

test("dispatchTaskKind: routes explicit_command correctly", () => {
  const spec = baseSpec({
    taskKind: "explicit_command",
    execution: { engine: "shell", command: ["ls", "-la"] },
  });
  const result = dispatchTaskKind(spec, profile);
  assert.deepEqual(result.command, ["ls", "-la"]);
});

test("dispatchTaskKind: routes assistant_job correctly", () => {
  const spec = baseSpec({
    taskKind: "assistant_job",
    execution: { engine: "agent_cli" },
  });
  const result = dispatchTaskKind(spec, profile);
  assert.equal(result.command[0], "codex");
});

test("dispatchTaskKind: routes verification_check correctly", () => {
  const spec = baseSpec({
    taskKind: "verification_check",
    execution: { engine: "shell" },
    acceptanceChecks: [{ checkId: "c1", label: "test", command: ["npm", "test"] }],
  });
  const result = dispatchTaskKind(spec, profile);
  assert.equal(result.command[0], "bash");
  assert.equal(result.command[1], "-lc");
});
