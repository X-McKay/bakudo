import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  profileCheckpoint,
  profileReport,
  profileSnapshot,
  resetProfile,
} from "../../src/host/startupProfiler.js";

type ProcessEnv = Record<string, string | undefined>;

const withEnv = async <T>(overrides: ProcessEnv, fn: () => Promise<T>): Promise<T> => {
  const env = (globalThis as unknown as { process: { env: ProcessEnv } }).process.env;
  const snapshot: ProcessEnv = {};
  for (const key of Object.keys(overrides)) {
    snapshot[key] = env[key];
    const value = overrides[key];
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(snapshot)) {
      if (value === undefined) {
        delete env[key];
      } else {
        env[key] = value;
      }
    }
  }
};

test("profileCheckpoint: records named checkpoints relative to start", () => {
  resetProfile();
  profileCheckpoint("alpha");
  profileCheckpoint("beta");
  const snap = profileSnapshot();
  assert.equal(snap.length, 2);
  assert.equal(snap[0]?.name, "alpha");
  assert.equal(snap[1]?.name, "beta");
  assert.ok(typeof snap[0]?.ms === "number");
  assert.ok(snap[1]!.ms >= snap[0]!.ms);
});

test("profileReport: no-op when BAKUDO_PROFILE unset", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bakudo-profile-"));
  try {
    await withEnv({ BAKUDO_PROFILE: undefined }, async () => {
      resetProfile();
      profileCheckpoint("noop");
      await profileReport(dir);
    });
    const entries = await readdir(dir);
    assert.equal(entries.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("profileReport: writes JSON when BAKUDO_PROFILE=1 and dir missing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bakudo-profile-"));
  try {
    await withEnv({ BAKUDO_PROFILE: "1" }, async () => {
      resetProfile();
      profileCheckpoint("entry");
      profileCheckpoint("done");
      await profileReport(dir);
    });
    const logDir = join(dir, ".bakudo", "log");
    const files = await readdir(logDir);
    assert.equal(files.length, 1);
    const match = files[0]?.startsWith("startup-");
    assert.equal(match, true);
    const content = await readFile(join(logDir, files[0]!), "utf8");
    const parsed = JSON.parse(content) as {
      checkpoints: Array<{ name: string }>;
      totalMs: number;
    };
    const names = parsed.checkpoints.map((c) => c.name);
    assert.ok(names.includes("entry"));
    assert.ok(names.includes("done"));
    assert.ok(typeof parsed.totalMs === "number");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("profileReport: swallows errors silently (non-fatal)", async () => {
  // Pointing at a deep unwritable path should still not throw.
  await withEnv({ BAKUDO_PROFILE: "1" }, async () => {
    resetProfile();
    profileCheckpoint("x");
    // Path with embedded NUL is rejected by Node, exercising the catch.
    await profileReport("/\u0000/nope");
  });
});
