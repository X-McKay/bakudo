import assert from "node:assert/strict";
import test from "node:test";

import { initialHostAppState } from "../../src/host/appState.js";
import { createCommandRegistry } from "../../src/host/commandRegistry.js";
import { buildDefaultCommandRegistry } from "../../src/host/commandRegistryDefaults.js";
import type { TickDeps } from "../../src/host/interactiveRenderLoop.js";
import { reduceHost } from "../../src/host/reducer.js";

const buildDeps = (): TickDeps => {
  const deps: TickDeps = {
    transcript: [],
    appState: initialHostAppState(),
    dispatch: (action) => {
      deps.appState = reduceHost(deps.appState, action);
    },
  };
  return deps;
};

test("command registry: register + get matches by name and alias", () => {
  const registry = createCommandRegistry();
  registry.register({
    name: "foo",
    aliases: ["f"],
    description: "",
    handler: () => {},
  });
  assert.ok(registry.get("foo"));
  assert.ok(registry.get("f"));
  assert.equal(registry.get("missing"), undefined);
});

test("command registry: duplicate name throws", () => {
  const registry = createCommandRegistry();
  registry.register({ name: "foo", description: "", handler: () => {} });
  assert.throws(() => {
    registry.register({ name: "foo", description: "", handler: () => {} });
  }, /already registered/);
});

test("command registry: alias colliding with command name throws", () => {
  const registry = createCommandRegistry();
  registry.register({ name: "foo", description: "", handler: () => {} });
  assert.throws(() => {
    registry.register({
      name: "bar",
      aliases: ["foo"],
      description: "",
      handler: () => {},
    });
  }, /alias/);
});

test("command registry: dispatch returns handled when handler returns void", async () => {
  const registry = createCommandRegistry();
  let called = false;
  registry.register({
    name: "ping",
    description: "",
    handler: () => {
      called = true;
    },
  });
  const outcome = await registry.dispatch("/ping", buildDeps());
  assert.equal(outcome.kind, "handled");
  assert.equal(called, true);
});

test("command registry: dispatch returns fallthrough when handler returns resolution", async () => {
  const registry = createCommandRegistry();
  registry.register({
    name: "status",
    description: "",
    handler: () => ({ argv: ["status", "session-1"] }),
  });
  const outcome = await registry.dispatch("/status", buildDeps());
  assert.equal(outcome.kind, "fallthrough");
  if (outcome.kind === "fallthrough") {
    assert.deepEqual(outcome.resolution.argv, ["status", "session-1"]);
  }
});

test("command registry: unknown slash command yields 'unknown'", async () => {
  const registry = createCommandRegistry();
  const outcome = await registry.dispatch("/nope", buildDeps());
  assert.equal(outcome.kind, "unknown");
});

test("command registry: plain text yields 'unknown'", async () => {
  const registry = createCommandRegistry();
  const outcome = await registry.dispatch("hello world", buildDeps());
  assert.equal(outcome.kind, "unknown");
});

test("default registry: registers expected commands and aliases", () => {
  const registry = buildDefaultCommandRegistry();
  for (const name of [
    "new",
    "resume",
    "sessions",
    "inspect",
    "mode",
    "autopilot",
    "compact",
    "clear",
    "help",
    "exit",
    "init",
    "run",
    "build",
    "plan",
    "status",
    "tasks",
    "review",
    "sandbox",
    "logs",
    "run-command",
    "palette",
  ]) {
    assert.ok(registry.get(name), `expected /${name} registered`);
  }
  assert.ok(registry.get("quit"), "expected /quit alias");
  assert.ok(registry.get("approve"), "expected /approve alias for /autopilot");
  assert.ok(registry.get("continue"), "expected /continue alias for /resume");
  assert.ok(registry.get("rc"), "expected /rc alias for /run-command");
});

test("default registry: /compact emits 'not yet available' stub event", async () => {
  const registry = buildDefaultCommandRegistry();
  const deps = buildDeps();
  const outcome = await registry.dispatch("/compact", deps);
  assert.equal(outcome.kind, "handled");
  assert.equal(deps.transcript.length, 1);
  assert.match(JSON.stringify(deps.transcript[0]), /not yet available/);
});

test("default registry: /mode cycles through standard → plan → autopilot when no arg", async () => {
  const registry = buildDefaultCommandRegistry();
  const deps = buildDeps();
  await registry.dispatch("/mode", deps);
  assert.equal(deps.appState.composer.mode, "plan");
  await registry.dispatch("/mode", deps);
  assert.equal(deps.appState.composer.mode, "autopilot");
  assert.equal(deps.appState.composer.autoApprove, true);
  await registry.dispatch("/mode", deps);
  assert.equal(deps.appState.composer.mode, "standard");
  assert.equal(deps.appState.composer.autoApprove, false);
});

test("default registry: /autopilot sets mode=autopilot", async () => {
  const registry = buildDefaultCommandRegistry();
  const deps = buildDeps();
  await registry.dispatch("/autopilot", deps);
  assert.equal(deps.appState.composer.mode, "autopilot");
  assert.equal(deps.appState.composer.autoApprove, true);
});

test("default registry: /help emits dynamic list from registry (not hardcoded)", async () => {
  const registry = buildDefaultCommandRegistry();
  const deps = buildDeps();
  const outcome = await registry.dispatch("/help", deps);
  assert.equal(outcome.kind, "handled");
  // The preamble line plus at least one command entry should be emitted.
  assert.ok(deps.transcript.length > 1, "expected at least 2 transcript entries from /help");
  // All entries should be 'event' items with label 'help'.
  for (const item of deps.transcript) {
    assert.equal(item.kind, "event");
    if (item.kind === "event") {
      assert.equal(item.label, "help");
    }
  }
  // Every non-hidden registered command should appear in the output.
  const visibleCommands = registry.list(deps.appState).filter((s) => s.hidden !== true);
  const helpText = deps.transcript
    .filter((item) => item.kind === "event")
    .map((item) => (item.kind === "event" ? item.detail : ""))
    .join("\n");
  for (const spec of visibleCommands) {
    assert.ok(
      helpText.includes(`/${spec.name}`),
      `expected /${spec.name} to appear in /help output`,
    );
  }
});
