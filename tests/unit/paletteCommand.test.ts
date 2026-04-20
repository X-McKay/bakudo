/**
 * Phase 5 PR7 — integration between the `/palette` slash command, the
 * launcher, and the keybinding registry.
 *
 * Covers:
 *  - `/palette` handler enqueues a command_palette overlay and dispatches
 *    the selected command through the registry.
 *  - `/palette` handler resolves with a transcript note when cancelled.
 *  - `registerPaletteKeybinding` / `registerSessionPickerKeybinding` hook
 *    into the keybinding registry under the expected context + action.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { initialHostAppState } from "../../src/host/appState.js";
import { buildDefaultCommandRegistry } from "../../src/host/commandRegistryDefaults.js";
import { answerCommandPaletteDialog } from "../../src/host/launchCommandPaletteDialog.js";
import type { TickDeps } from "../../src/host/interactiveRenderLoop.js";
import { clearKeybindings, getKeybindingsFor } from "../../src/host/keybindings/hooks.js";
import { registerPaletteKeybinding } from "../../src/host/commands/palette.js";
import { registerSessionPickerKeybinding } from "../../src/host/commands/session.js";
import { resetPromptResolvers } from "../../src/host/promptResolvers.js";

test("/palette handler: dispatches the chosen command via the registry", async () => {
  resetPromptResolvers();
  const registry = buildDefaultCommandRegistry();
  const transcript: TickDeps["transcript"] = [];
  const deps: TickDeps = {
    transcript,
    appState: initialHostAppState(),
    dispatch: () => {},
  };
  const dispatcher = registry.dispatch("/palette", deps);
  // Give the palette launcher a moment to enqueue.
  await Promise.resolve();
  await Promise.resolve();
  // Answer the palette with `/compact` — emits a stable transcript event
  // but does not clear the transcript (`/clear` would wipe the palette
  // note we're asserting on).
  const answered = answerCommandPaletteDialog(
    {
      getState: () => deps.appState,
      setState: (next) => {
        deps.appState = next;
      },
    },
    "compact",
  );
  assert.ok(answered !== null);
  const outcome = await dispatcher;
  assert.equal(outcome.kind, "handled");
  assert.ok(
    transcript.some(
      (item) =>
        item.kind === "event" && item.label === "palette" && /\/compact/.test(item.detail ?? ""),
    ),
    "expected palette event with /compact detail",
  );
  assert.ok(
    transcript.some(
      (item) =>
        item.kind === "event" &&
        item.label === "compact" &&
        /not yet available/.test(item.detail ?? ""),
    ),
    "expected /compact stub event",
  );
});

test("/palette handler: cancel path emits a cancel note", async () => {
  resetPromptResolvers();
  const registry = buildDefaultCommandRegistry();
  const transcript: TickDeps["transcript"] = [];
  const deps: TickDeps = {
    transcript,
    appState: initialHostAppState(),
    dispatch: () => {},
  };
  const dispatcher = registry.dispatch("/palette", deps);
  await Promise.resolve();
  await Promise.resolve();
  // Empty-string answer is treated as cancel by the launcher.
  answerCommandPaletteDialog(
    {
      getState: () => deps.appState,
      setState: (next) => {
        deps.appState = next;
      },
    },
    "",
  );
  const outcome = await dispatcher;
  assert.equal(outcome.kind, "handled");
  assert.ok(
    transcript.some(
      (item) =>
        item.kind === "event" && item.label === "palette" && /cancelled/.test(item.detail ?? ""),
    ),
    "expected palette cancel note",
  );
});

test("registerPaletteKeybinding: registers under Global → app:commandPalette", () => {
  clearKeybindings();
  let triggered = false;
  const dispose = registerPaletteKeybinding(() => {
    triggered = true;
  });
  try {
    const handlers = getKeybindingsFor("Global");
    const handler = handlers.get("app:commandPalette");
    assert.ok(handler !== undefined, "expected Global/app:commandPalette handler");
    handler?.({ action: "app:commandPalette" });
    assert.equal(triggered, true);
  } finally {
    dispose();
    clearKeybindings();
  }
});

test("registerSessionPickerKeybinding: registers under Global → history:search", () => {
  clearKeybindings();
  let triggered = false;
  const dispose = registerSessionPickerKeybinding(() => {
    triggered = true;
  });
  try {
    const handlers = getKeybindingsFor("Global");
    const handler = handlers.get("history:search");
    assert.ok(handler !== undefined, "expected Global/history:search handler");
    handler?.({ action: "history:search" });
    assert.equal(triggered, true);
  } finally {
    dispose();
    clearKeybindings();
  }
});
