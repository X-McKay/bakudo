import assert from "node:assert/strict";
import test from "node:test";

import { buildTurnIntent, classifyIntent } from "../../src/host/intentClassifier.js";

// ---------------------------------------------------------------------------
// classifyIntent
// ---------------------------------------------------------------------------

test("classifyIntent: isExplicitCommand overrides everything", () => {
  assert.equal(
    classifyIntent("run tests", "standard", { isExplicitCommand: true }),
    "run_explicit_command",
  );
});

test("classifyIntent: isExplicitCommand overrides even plan mode", () => {
  assert.equal(
    classifyIntent("explain code", "plan", { isExplicitCommand: true }),
    "run_explicit_command",
  );
});

test("classifyIntent: plan mode → inspect_repository", () => {
  assert.equal(classifyIntent("add a feature", "plan"), "inspect_repository");
});

test("classifyIntent: plan mode overrides check-like prompt", () => {
  assert.equal(classifyIntent("run tests", "plan"), "inspect_repository");
});

test('classifyIntent: "run tests" → run_check', () => {
  assert.equal(classifyIntent("run tests", "standard"), "run_check");
});

test('classifyIntent: "run lint" → run_check', () => {
  assert.equal(classifyIntent("run lint", "standard"), "run_check");
});

test('classifyIntent: "execute typecheck" → run_check', () => {
  assert.equal(classifyIntent("execute typecheck", "standard"), "run_check");
});

test('classifyIntent: "check build" → run_check', () => {
  assert.equal(classifyIntent("check build", "standard"), "run_check");
});

test('classifyIntent: "/check" slash command → run_check', () => {
  assert.equal(classifyIntent("/check something", "standard"), "run_check");
});

test('classifyIntent: "add a feature" → implement_change (default)', () => {
  assert.equal(classifyIntent("add a feature", "standard"), "implement_change");
});

test('classifyIntent: "explain this code" → implement_change (catch-all)', () => {
  assert.equal(classifyIntent("explain this code", "standard"), "implement_change");
});

test("classifyIntent: autopilot mode with normal prompt → implement_change", () => {
  assert.equal(classifyIntent("refactor the parser", "autopilot"), "implement_change");
});

test("classifyIntent: autopilot mode with check prompt → run_check", () => {
  assert.equal(classifyIntent("run test suite", "autopilot"), "run_check");
});

// ---------------------------------------------------------------------------
// buildTurnIntent
// ---------------------------------------------------------------------------

test("buildTurnIntent: intentId matches expected format", () => {
  const intent = buildTurnIntent("hello", "standard", "/repo");
  assert.match(intent.intentId, /^intent-\d+-[a-f0-9]{8}$/u);
});

test("buildTurnIntent: inspect_repository has correct goals and constraints", () => {
  const intent = buildTurnIntent("explain the architecture", "plan", "/repo");
  assert.equal(intent.kind, "inspect_repository");
  assert.deepEqual(intent.acceptanceGoals, ["produce summary", "do not modify repo"]);
  assert.deepEqual(intent.constraints, ["read-only intent"]);
});

test("buildTurnIntent: implement_change has correct goals and constraints", () => {
  const intent = buildTurnIntent("add logging", "standard", "/repo");
  assert.equal(intent.kind, "implement_change");
  assert.deepEqual(intent.acceptanceGoals, ["make requested change", "run targeted checks"]);
  assert.deepEqual(intent.constraints, ["prefer minimal diff", "summarize results clearly"]);
});

test("buildTurnIntent: run_check has correct goals and constraints", () => {
  const intent = buildTurnIntent("run tests", "standard", "/repo");
  assert.equal(intent.kind, "run_check");
  assert.deepEqual(intent.acceptanceGoals, ["execute command and capture outputs"]);
  assert.deepEqual(intent.constraints, ["explicit check path"]);
});

test("buildTurnIntent: run_explicit_command has correct goals and constraints", () => {
  const intent = buildTurnIntent("ls -la", "standard", "/repo", { isExplicitCommand: true });
  assert.equal(intent.kind, "run_explicit_command");
  assert.deepEqual(intent.acceptanceGoals, ["execute command and capture outputs"]);
  assert.deepEqual(intent.constraints, ["explicit shell path"]);
});

test("buildTurnIntent: preserves prompt and repoRoot", () => {
  const intent = buildTurnIntent("do stuff", "autopilot", "/my/repo");
  assert.equal(intent.prompt, "do stuff");
  assert.equal(intent.repoRoot, "/my/repo");
  assert.equal(intent.composerMode, "autopilot");
});

test("buildTurnIntent: forwards tokenBudget when provided", () => {
  const intent = buildTurnIntent("fix bug", "standard", "/repo", { tokenBudget: 50000 });
  assert.equal(intent.tokenBudget, 50000);
});

test("buildTurnIntent: omits tokenBudget when not provided", () => {
  const intent = buildTurnIntent("fix bug", "standard", "/repo");
  assert.equal(intent.tokenBudget, undefined);
});
