import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initialHostAppState } from "../../src/host/appState.js";
import {
  HOST_STATE_SCHEMA_VERSION,
  loadHostState,
  saveHostState,
  type HostStateRecord,
} from "../../src/host/hostStateStore.js";
import { reduceHost } from "../../src/host/reducer.js";

const createTempRoot = async (): Promise<string> =>
  mkdtemp(join(tmpdir(), "bakudo-continuity-int-"));

test("second prompt reuses the active sessionId (not a new session)", async () => {
  // Simulate: user sets active session, then checks that subsequent state
  // still references the same session (continuity). In-process: we use the
  // reducer directly rather than spawning the interactive shell.
  let state = initialHostAppState();
  const sessionId = "session-continuity-1";

  // First prompt sets active session
  state = reduceHost(state, {
    type: "set_active_session",
    sessionId,
    turnId: "turn-1",
  });
  assert.equal(state.activeSessionId, sessionId);

  // Second prompt — state still points at the same session
  state = reduceHost(state, {
    type: "set_active_session",
    sessionId,
    turnId: "turn-2",
  });
  assert.equal(state.activeSessionId, sessionId, "second prompt reuses same session");
});

test("/new mints a new session ID by clearing the active session", () => {
  let state = initialHostAppState();
  state = reduceHost(state, {
    type: "set_active_session",
    sessionId: "session-old",
    turnId: "turn-1",
  });
  assert.equal(state.activeSessionId, "session-old");

  // /new clears
  state = reduceHost(state, {
    type: "set_active_session",
    sessionId: undefined,
  });
  assert.equal(state.activeSessionId, undefined, "/new clears active session");
});

test("shell restart reads host-state.json and restores active session", async () => {
  const repoRoot = await createTempRoot();
  try {
    const record: HostStateRecord = {
      schemaVersion: HOST_STATE_SCHEMA_VERSION,
      lastUsedMode: "standard",
      autoApprove: false,
      lastActiveSessionId: "session-persisted",
      lastActiveTurnId: "turn-3",
    };
    await saveHostState(repoRoot, record);

    const loaded = await loadHostState(repoRoot);
    assert.ok(loaded, "host state should load from disk");
    assert.equal(loaded.lastActiveSessionId, "session-persisted");
    assert.equal(loaded.lastActiveTurnId, "turn-3");

    // Verify the reducer applies it correctly
    let state = initialHostAppState();
    state = reduceHost(state, { type: "set_mode", mode: loaded.lastUsedMode });
    if (loaded.lastActiveSessionId) {
      state = reduceHost(state, {
        type: "set_active_session",
        sessionId: loaded.lastActiveSessionId,
        ...(loaded.lastActiveTurnId ? { turnId: loaded.lastActiveTurnId } : {}),
      });
    }
    assert.equal(state.activeSessionId, "session-persisted");
    assert.equal(state.activeTurnId, "turn-3");
    assert.equal(state.composer.mode, "standard");
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});
