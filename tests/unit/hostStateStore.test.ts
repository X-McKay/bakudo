import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  HOST_STATE_SCHEMA_VERSION,
  hostStateFilePath,
  loadHostState,
  saveHostState,
} from "../../src/host/hostStateStore.js";

const createTempRepo = async (): Promise<string> => mkdtemp(join(tmpdir(), "bakudo-host-state-"));

test("hostStateFilePath returns .bakudo/host-state.json under repo", () => {
  assert.equal(hostStateFilePath("/tmp/repo"), "/tmp/repo/.bakudo/host-state.json");
});

test("loadHostState returns null when file does not exist", async () => {
  const repoRoot = await createTempRepo();
  try {
    assert.equal(await loadHostState(repoRoot), null);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("loadHostState returns null for malformed JSON", async () => {
  const repoRoot = await createTempRepo();
  try {
    await mkdir(join(repoRoot, ".bakudo"), { recursive: true });
    await writeFile(join(repoRoot, ".bakudo", "host-state.json"), "{not json", "utf8");
    assert.equal(await loadHostState(repoRoot), null);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("saveHostState writes atomic JSON and loadHostState round-trips", async () => {
  const repoRoot = await createTempRepo();
  try {
    await saveHostState(repoRoot, {
      schemaVersion: HOST_STATE_SCHEMA_VERSION,
      lastActiveSessionId: "session-abc",
      lastActiveTurnId: "turn-3",
      lastUsedMode: "plan",
      autoApprove: true,
    });
    const loaded = await loadHostState(repoRoot);
    assert.ok(loaded);
    assert.equal(loaded.schemaVersion, HOST_STATE_SCHEMA_VERSION);
    assert.equal(loaded.lastActiveSessionId, "session-abc");
    assert.equal(loaded.lastActiveTurnId, "turn-3");
    assert.equal(loaded.lastUsedMode, "plan");
    assert.equal(loaded.autoApprove, true);

    // JSON on disk is indented for readability
    const onDisk = await readFile(join(repoRoot, ".bakudo", "host-state.json"), "utf8");
    assert.match(onDisk, /"lastActiveSessionId": "session-abc"/);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("saveHostState omits absent optional fields", async () => {
  const repoRoot = await createTempRepo();
  try {
    await saveHostState(repoRoot, {
      schemaVersion: HOST_STATE_SCHEMA_VERSION,
      lastUsedMode: "standard",
      autoApprove: false,
    });
    const loaded = await loadHostState(repoRoot);
    assert.ok(loaded);
    assert.equal(loaded.lastActiveSessionId, undefined);
    assert.equal(loaded.lastActiveTurnId, undefined);
    assert.equal(loaded.lastUsedMode, "standard");
    assert.equal(loaded.autoApprove, false);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("loadHostState migrates legacy 'build' mode to 'standard'", async () => {
  const repoRoot = await createTempRepo();
  try {
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(join(repoRoot, ".bakudo"), { recursive: true });
    await writeFile(
      join(repoRoot, ".bakudo", "host-state.json"),
      JSON.stringify({ schemaVersion: 1, lastUsedMode: "build", autoApprove: false }),
      "utf8",
    );
    const loaded = await loadHostState(repoRoot);
    assert.ok(loaded);
    assert.equal(loaded.lastUsedMode, "standard");
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("loadHostState returns null for structurally invalid JSON (wrong field types)", async () => {
  const repoRoot = await createTempRepo();
  try {
    await mkdir(join(repoRoot, ".bakudo"), { recursive: true });
    // Valid JSON but schemaVersion is a string instead of number.
    await writeFile(
      join(repoRoot, ".bakudo", "host-state.json"),
      JSON.stringify({ schemaVersion: "one", lastUsedMode: "standard", autoApprove: false }),
      "utf8",
    );
    assert.equal(await loadHostState(repoRoot), null);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});
