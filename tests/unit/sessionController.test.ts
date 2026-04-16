import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { SessionStore } from "../../src/sessionStore.js";
import type { HostCliArgs } from "../../src/host/parsing.js";
import { resumeNamedSession } from "../../src/host/sessionController.js";

const createTempRoot = async (): Promise<string> => mkdtemp(join(tmpdir(), "bakudo-ctrl-"));

const baseArgs = (storageRoot: string): HostCliArgs => ({
  command: "run",
  config: "config/default.json",
  aboxBin: "abox",
  mode: "build",
  yes: false,
  shell: "bash",
  timeoutSeconds: 120,
  maxOutputBytes: 256 * 1024,
  heartbeatIntervalMs: 5000,
  killGraceMs: 2000,
  storageRoot,
  copilot: {},
});

test("resumeNamedSession: returns null for unknown session", async () => {
  const rootDir = await createTempRoot();
  try {
    const result = await resumeNamedSession("nope", baseArgs(rootDir));
    assert.equal(result, null);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("resumeNamedSession: loads an existing session record", async () => {
  const rootDir = await createTempRoot();
  try {
    const store = new SessionStore(rootDir);
    await store.createSession({
      sessionId: "session-a",
      goal: "x",
      repoRoot: ".",
      assumeDangerousSkipPermissions: false,
      status: "planned",
      turns: [
        {
          turnId: "turn-1",
          prompt: "x",
          mode: "build",
          status: "queued",
          attempts: [],
          createdAt: "2026-04-14T12:00:00.000Z",
          updatedAt: "2026-04-14T12:00:00.000Z",
        },
      ],
    });

    const result = await resumeNamedSession("session-a", baseArgs(rootDir));
    assert.ok(result);
    assert.equal(result.sessionId, "session-a");
    assert.equal(result.turns.length, 1);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
