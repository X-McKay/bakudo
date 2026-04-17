import assert from "node:assert/strict";
import test from "node:test";

import type { TurnIntent } from "../../src/attemptProtocol.js";
import type { BakudoConfig } from "../../src/host/config.js";
import {
  compileAttemptSpec,
  composerModeToTaskMode,
  type CompilerContext,
} from "../../src/host/attemptCompiler.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const baseContext = (overrides?: Partial<CompilerContext>): CompilerContext => ({
  sessionId: "sess-1",
  turnId: "turn-1",
  attemptId: "attempt-1",
  taskId: "task-1",
  repoRoot: "/repo",
  config: {},
  ...overrides,
});

const baseIntent = (overrides?: Partial<TurnIntent>): TurnIntent => ({
  intentId: "intent-123-abcdef01",
  kind: "implement_change",
  composerMode: "standard",
  prompt: "add logging to the parser",
  repoRoot: "/repo",
  acceptanceGoals: ["make requested change", "run targeted checks"],
  constraints: ["prefer minimal diff", "summarize results clearly"],
  ...overrides,
});

// ---------------------------------------------------------------------------
// composerModeToTaskMode
// ---------------------------------------------------------------------------

test("composerModeToTaskMode: standard → build", () => {
  assert.equal(composerModeToTaskMode("standard"), "build");
});

test("composerModeToTaskMode: autopilot → build", () => {
  assert.equal(composerModeToTaskMode("autopilot"), "build");
});

test("composerModeToTaskMode: plan → plan", () => {
  assert.equal(composerModeToTaskMode("plan"), "plan");
});

// ---------------------------------------------------------------------------
// Task kind mapping
// ---------------------------------------------------------------------------

test("inspect_repository compiles to assistant_job with engine agent_cli and mode plan", () => {
  const intent = baseIntent({
    kind: "inspect_repository",
    composerMode: "plan",
    acceptanceGoals: ["produce summary", "do not modify repo"],
    constraints: ["read-only intent"],
  });
  const spec = compileAttemptSpec(intent, baseContext());
  assert.equal(spec.taskKind, "assistant_job");
  assert.equal(spec.execution.engine, "agent_cli");
  assert.equal(spec.mode, "plan");
  assert.equal(spec.execution.command, undefined);
});

test("implement_change compiles to assistant_job with mode build", () => {
  const spec = compileAttemptSpec(baseIntent(), baseContext());
  assert.equal(spec.taskKind, "assistant_job");
  assert.equal(spec.execution.engine, "agent_cli");
  assert.equal(spec.mode, "build");
  assert.equal(spec.execution.command, undefined);
});

test("run_explicit_command compiles to explicit_command with engine shell and command populated", () => {
  const intent = baseIntent({
    kind: "run_explicit_command",
    prompt: "/run-command ls -la",
    acceptanceGoals: ["execute command and capture outputs"],
    constraints: ["explicit shell path"],
  });
  const spec = compileAttemptSpec(intent, baseContext());
  assert.equal(spec.taskKind, "explicit_command");
  assert.equal(spec.execution.engine, "shell");
  assert.deepEqual(spec.execution.command, ["bash", "-lc", "ls -la"]);
});

test("run_check compiles to verification_check with engine shell", () => {
  const intent = baseIntent({
    kind: "run_check",
    prompt: "run tests",
    acceptanceGoals: ["execute command and capture outputs"],
    constraints: ["explicit check path"],
  });
  const spec = compileAttemptSpec(intent, baseContext());
  assert.equal(spec.taskKind, "verification_check");
  assert.equal(spec.execution.engine, "shell");
  assert.deepEqual(spec.execution.command, ["bash", "-lc", "tests"]);
});

// ---------------------------------------------------------------------------
// Permission modes
// ---------------------------------------------------------------------------

test("autopilot → allowAllTools true, noAskUser true", () => {
  const intent = baseIntent({ composerMode: "autopilot" });
  const spec = compileAttemptSpec(intent, baseContext());
  assert.equal(spec.permissions.allowAllTools, true);
  assert.equal(spec.permissions.noAskUser, true);
});

test("plan mode → deny-all defaults for shell and write", () => {
  const intent = baseIntent({
    kind: "inspect_repository",
    composerMode: "plan",
    acceptanceGoals: ["produce summary", "do not modify repo"],
    constraints: ["read-only intent"],
  });
  const spec = compileAttemptSpec(intent, baseContext());
  const shellRule = spec.permissions.rules.find((r) => r.tool === "shell");
  const writeRule = spec.permissions.rules.find((r) => r.tool === "write");
  assert.equal(shellRule?.effect, "deny");
  assert.equal(writeRule?.effect, "deny");
  assert.equal(spec.permissions.allowAllTools, false);
  assert.equal(spec.permissions.noAskUser, false);
});

test("standard mode → ask-all defaults", () => {
  const spec = compileAttemptSpec(baseIntent(), baseContext());
  const shellRule = spec.permissions.rules.find((r) => r.tool === "shell");
  const writeRule = spec.permissions.rules.find((r) => r.tool === "write");
  const networkRule = spec.permissions.rules.find((r) => r.tool === "network");
  assert.equal(shellRule?.effect, "ask");
  assert.equal(writeRule?.effect, "ask");
  assert.equal(networkRule?.effect, "ask");
  assert.equal(spec.permissions.allowAllTools, false);
  assert.equal(spec.permissions.noAskUser, false);
});

// ---------------------------------------------------------------------------
// Token budget
// ---------------------------------------------------------------------------

test("token budget forwarded from intent", () => {
  const intent = baseIntent({ tokenBudget: 75000 });
  const spec = compileAttemptSpec(intent, baseContext());
  assert.equal(spec.budget.tokenBudget, 75000);
});

test("token budget omitted when not in intent", () => {
  const spec = compileAttemptSpec(baseIntent(), baseContext());
  assert.equal(spec.budget.tokenBudget, undefined);
});

// ---------------------------------------------------------------------------
// Agent profile override
// ---------------------------------------------------------------------------

test("agent profile from config overrides permission defaults", () => {
  const config: BakudoConfig = {
    agents: {
      default: {
        permissions: { shell: "allow", write: "deny", network: "ask" },
      },
    },
  };
  const spec = compileAttemptSpec(baseIntent(), baseContext({ config }));
  const shellRule = spec.permissions.rules.find((r) => r.tool === "shell");
  const writeRule = spec.permissions.rules.find((r) => r.tool === "write");
  const networkRule = spec.permissions.rules.find((r) => r.tool === "network");
  assert.equal(shellRule?.effect, "allow");
  assert.equal(writeRule?.effect, "deny");
  assert.equal(networkRule?.effect, "ask");
  // Source should be agent_profile
  assert.equal(shellRule?.source, "agent_profile");
});

// ---------------------------------------------------------------------------
// Schema version
// ---------------------------------------------------------------------------

test("schemaVersion is 3", () => {
  const spec = compileAttemptSpec(baseIntent(), baseContext());
  assert.equal(spec.schemaVersion, 3);
});

// ---------------------------------------------------------------------------
// Artifact requests
// ---------------------------------------------------------------------------

test("assistant_job has result, summary, and patch artifact requests", () => {
  const spec = compileAttemptSpec(baseIntent(), baseContext());
  assert.equal(spec.artifactRequests.length, 3);
  assert.equal(spec.artifactRequests[0]?.name, "result.json");
  assert.equal(spec.artifactRequests[0]?.required, true);
  assert.equal(spec.artifactRequests[1]?.name, "summary.md");
  assert.equal(spec.artifactRequests[1]?.required, false);
  assert.equal(spec.artifactRequests[2]?.name, "patch.diff");
  assert.equal(spec.artifactRequests[2]?.required, false);
});

test("explicit_command has only result artifact request", () => {
  const intent = baseIntent({
    kind: "run_explicit_command",
    prompt: "echo hello",
    acceptanceGoals: ["execute command and capture outputs"],
    constraints: ["explicit shell path"],
  });
  const spec = compileAttemptSpec(intent, baseContext());
  assert.equal(spec.artifactRequests.length, 1);
  assert.equal(spec.artifactRequests[0]?.name, "result.json");
  assert.equal(spec.artifactRequests[0]?.required, true);
});

test("verification_check has only result artifact request", () => {
  const intent = baseIntent({
    kind: "run_check",
    prompt: "run lint",
    acceptanceGoals: ["execute command and capture outputs"],
    constraints: ["explicit check path"],
  });
  const spec = compileAttemptSpec(intent, baseContext());
  assert.equal(spec.artifactRequests.length, 1);
  assert.equal(spec.artifactRequests[0]?.name, "result.json");
});

// ---------------------------------------------------------------------------
// Instructions
// ---------------------------------------------------------------------------

test("instructions include user prompt and constraints", () => {
  const spec = compileAttemptSpec(baseIntent(), baseContext());
  assert.ok(spec.instructions.some((i) => i.includes("add logging to the parser")));
  assert.ok(spec.instructions.some((i) => i.includes("prefer minimal diff")));
  assert.ok(spec.instructions.some((i) => i.includes("summarize results clearly")));
});

// ---------------------------------------------------------------------------
// Prompt content
// ---------------------------------------------------------------------------

test("assistant_job prompt is descriptive language, not raw user prompt", () => {
  const spec = compileAttemptSpec(baseIntent(), baseContext());
  assert.ok(!spec.prompt.includes("add logging to the parser"));
  assert.ok(spec.prompt.includes("Implement the requested change"));
});

test("explicit_command prompt IS the raw command", () => {
  const intent = baseIntent({
    kind: "run_explicit_command",
    prompt: "/run-command make build",
    acceptanceGoals: ["execute command and capture outputs"],
    constraints: ["explicit shell path"],
  });
  const spec = compileAttemptSpec(intent, baseContext());
  assert.equal(spec.prompt, "/run-command make build");
});

// ---------------------------------------------------------------------------
// IDs forwarded
// ---------------------------------------------------------------------------

test("context IDs and intentId are forwarded to spec", () => {
  const ctx = baseContext({
    sessionId: "s-42",
    turnId: "t-7",
    attemptId: "a-3",
    taskId: "task-99",
  });
  const intent = baseIntent({ intentId: "intent-500-deadbeef" });
  const spec = compileAttemptSpec(intent, ctx);
  assert.equal(spec.sessionId, "s-42");
  assert.equal(spec.turnId, "t-7");
  assert.equal(spec.attemptId, "a-3");
  assert.equal(spec.taskId, "task-99");
  assert.equal(spec.intentId, "intent-500-deadbeef");
});

// ---------------------------------------------------------------------------
// Budget defaults
// ---------------------------------------------------------------------------

test("budget uses sensible defaults", () => {
  const spec = compileAttemptSpec(baseIntent(), baseContext());
  assert.equal(spec.budget.timeoutSeconds, 300);
  assert.equal(spec.budget.maxOutputBytes, 10_000_000);
  assert.equal(spec.budget.heartbeatIntervalMs, 5000);
});
