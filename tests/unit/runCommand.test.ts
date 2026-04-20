import assert from "node:assert/strict";
import test from "node:test";

import { initialHostAppState } from "../../src/host/appState.js";
import { buildDefaultCommandRegistry } from "../../src/host/commandRegistryDefaults.js";
import type { TickDeps } from "../../src/host/interactiveRenderLoop.js";
import { parseHostArgs } from "../../src/host/parsing.js";
import { buildRunCommandSpec } from "../../src/host/commands/runCommand.js";

const buildDeps = (): TickDeps => ({
  transcript: [],
  appState: initialHostAppState(),
  dispatch: () => {},
});

// ---------------------------------------------------------------------------
// buildRunCommandSpec — AttemptSpec shape
// ---------------------------------------------------------------------------

test("buildRunCommandSpec: produces AttemptSpec with explicit_command taskKind", () => {
  const spec = buildRunCommandSpec("echo hello", {
    sessionId: "session-1",
    taskId: "task-1",
    cwd: "/tmp",
    autoApprove: false,
  });

  assert.equal(spec.schemaVersion, 3);
  assert.equal(spec.taskKind, "explicit_command");
  assert.equal(spec.execution.engine, "shell");
  assert.deepEqual(spec.execution.command, ["bash", "-lc", "echo hello"]);
  assert.equal(spec.prompt, "echo hello");
  assert.equal(spec.mode, "build");
  assert.equal(spec.permissions.allowAllTools, false);
  assert.equal(spec.cwd, "/tmp");
});

test("buildRunCommandSpec: sets allowAllTools when autoApprove is true", () => {
  const spec = buildRunCommandSpec("npm test", {
    sessionId: "session-1",
    taskId: "task-1",
    cwd: ".",
    autoApprove: true,
  });

  assert.equal(spec.permissions.allowAllTools, true);
  assert.equal(spec.permissions.noAskUser, true);
});

test("buildRunCommandSpec: has required AttemptSpec fields", () => {
  const spec = buildRunCommandSpec("ls -la", {
    sessionId: "session-1",
    taskId: "task-1",
    cwd: ".",
    autoApprove: false,
  });

  assert.ok(spec.turnId.startsWith("turn-"));
  assert.ok(spec.attemptId.startsWith("attempt-"));
  assert.ok(spec.intentId.startsWith("intent-"));
  assert.equal(spec.sessionId, "session-1");
  assert.equal(spec.taskId, "task-1");
  assert.deepEqual(spec.instructions, []);
  assert.deepEqual(spec.acceptanceChecks, []);
  assert.deepEqual(spec.artifactRequests, []);
  assert.equal(spec.budget.timeoutSeconds, 120);
});

// ---------------------------------------------------------------------------
// /run-command handler via registry
// ---------------------------------------------------------------------------

test("/run-command: registered in default registry", () => {
  const registry = buildDefaultCommandRegistry();
  assert.ok(registry.get("run-command"), "expected /run-command registered");
  assert.ok(registry.get("rc"), "expected /rc alias registered");
});

test("/run-command: dispatches fallthrough with run argv", async () => {
  const registry = buildDefaultCommandRegistry();
  const deps = buildDeps();
  const outcome = await registry.dispatch("/run-command echo hello", deps);
  assert.equal(outcome.kind, "fallthrough");
  if (outcome.kind === "fallthrough") {
    assert.equal(outcome.resolution.argv[0], "run");
    assert.ok(
      outcome.resolution.argv.includes("--explicit-command"),
      "expected hidden explicit-command flag in argv",
    );
    assert.ok(outcome.resolution.argv.includes("--mode"));
    assert.ok(outcome.resolution.argv.includes("build"));
    assert.ok(outcome.resolution.argv.includes("echo hello"));
    assert.ok(outcome.resolution.sessionId);
    assert.ok(outcome.resolution.taskId);

    const parsed = parseHostArgs(outcome.resolution.argv);
    assert.equal(parsed.command, "run");
    assert.equal(parsed.goal, "echo hello");
    assert.equal(parsed.isExplicitCommand, true);
  }
});

test("/run-command: emits error when no command provided", async () => {
  const registry = buildDefaultCommandRegistry();
  const deps = buildDeps();
  const outcome = await registry.dispatch("/run-command", deps);
  assert.equal(outcome.kind, "handled");
  assert.equal(deps.transcript.length, 1);
  assert.ok(JSON.stringify(deps.transcript[0]).includes("usage"));
});

test("/run-command: passes --yes when in autopilot mode", async () => {
  const registry = buildDefaultCommandRegistry();
  const deps = buildDeps();
  deps.appState = {
    ...deps.appState,
    composer: { mode: "autopilot", autoApprove: true, text: "", model: "", agent: "", provider: "" },
  };
  const outcome = await registry.dispatch("/run-command npm test", deps);
  assert.equal(outcome.kind, "fallthrough");
  if (outcome.kind === "fallthrough") {
    assert.ok(outcome.resolution.argv.includes("--yes"), "expected --yes in argv");
  }
});
