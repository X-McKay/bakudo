/**
 * Phase 6 Wave 6e PR16 — end-to-end `.bakudo/` → XDG migration test.
 *
 * Wires the migrator against a real tempdir layout + real `fs/promises`
 * so rename semantics (populated dir, marker durability, second-run
 * no-op) are exercised end-to-end.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  MIGRATION_MARKER_FILENAME,
  MIGRATION_V1_TO_V2_SKIPPED_KIND,
  migrateToXdg,
  type MigrationFs,
  type MigrationPaths,
} from "../../src/host/xdgMigration.js";
import type { SessionEventEnvelope } from "../../src/protocol.js";

const realFs: MigrationFs = {
  stat: async (p) => {
    try {
      const st = await stat(p);
      return { isDirectory: () => st.isDirectory() };
    } catch {
      return null;
    }
  },
  mkdir: async (p, opts) => {
    await mkdir(p, opts);
  },
  rename: async (src, dst) => {
    await rename(src, dst);
  },
  writeFile: (p, data) => writeFile(p, data, "utf8"),
  exists: async (p) => {
    try {
      await stat(p);
      return true;
    } catch {
      return false;
    }
  },
};

const makeLegacyLayout = async (
  root: string,
): Promise<{ paths: MigrationPaths; repoRoot: string; home: string }> => {
  const repoRoot = join(root, "repo");
  const home = join(root, "home");
  const xdgLogDir = join(home, ".local", "share", "bakudo", "log");
  await mkdir(join(repoRoot, ".bakudo", "log"), { recursive: true });
  await writeFile(
    join(repoRoot, ".bakudo", "log", "startup-1.json"),
    '{"fake":"startup"}\n',
    "utf8",
  );
  await writeFile(join(repoRoot, ".bakudo", "config.json"), '{"mode":"standard"}\n', "utf8");
  await writeFile(
    join(repoRoot, ".bakudo", "host-state.json"),
    '{"activeSessionId":null}\n',
    "utf8",
  );
  await mkdir(join(repoRoot, ".bakudo", "sessions"), { recursive: true });
  await writeFile(join(repoRoot, ".bakudo", "sessions", "index.json"), '{"entries":[]}\n', "utf8");
  await writeFile(join(repoRoot, ".bakudo", "approvals.jsonl"), "", "utf8");
  await mkdir(join(home, ".bakudo", "log"), { recursive: true });
  await writeFile(join(home, ".bakudo", "log", "spans-old.json"), '{"old":"span"}\n', "utf8");
  await mkdir(join(home, ".bakudo", "spans"), { recursive: true });
  return { paths: { repoRoot, home, xdgLogDir }, repoRoot, home };
};

const withTempRoot = async (fn: (root: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "bakudo-xdg-migration-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

test("integration: end-to-end migration moves user-global, keeps repo-local", async () => {
  await withTempRoot(async (root) => {
    const { paths, repoRoot, home } = await makeLegacyLayout(root);
    const emitted: SessionEventEnvelope[] = [];
    const result = await migrateToXdg({
      fs: realFs,
      paths,
      emit: (env) => emitted.push(env),
    });
    assert.equal(result.outcome, "migrated");
    assert.equal(emitted.length, 1);
    const payload = emitted[0]!.payload as { skippedKind?: string };
    assert.equal(payload.skippedKind, MIGRATION_V1_TO_V2_SKIPPED_KIND);

    // Repo-local bits stay put.
    await assert.doesNotReject(() => stat(join(repoRoot, ".bakudo", "config.json")));
    await assert.doesNotReject(() => stat(join(repoRoot, ".bakudo", "host-state.json")));
    await assert.doesNotReject(() => stat(join(repoRoot, ".bakudo", "sessions", "index.json")));
    await assert.doesNotReject(() => stat(join(repoRoot, ".bakudo", "approvals.jsonl")));
    // Legacy dirs gone from source.
    await assert.rejects(() => stat(join(repoRoot, ".bakudo", "log")));
    await assert.rejects(() => stat(join(home, ".bakudo", "log")));
    await assert.rejects(() => stat(join(home, ".bakudo", "spans")));
    // Destination has the payload + children preserved.
    const migratedStartup = await readFile(
      join(paths.xdgLogDir, "repo-repo-log", "startup-1.json"),
      "utf8",
    );
    assert.match(migratedStartup, /fake/);
    await assert.doesNotReject(() => stat(join(paths.xdgLogDir, MIGRATION_MARKER_FILENAME)));
  });
});

test("integration: second invocation is a no-op (no second event, no data change)", async () => {
  await withTempRoot(async (root) => {
    const { paths } = await makeLegacyLayout(root);
    const emitted: SessionEventEnvelope[] = [];
    const emit = (env: SessionEventEnvelope): void => {
      emitted.push(env);
    };
    const first = await migrateToXdg({ fs: realFs, paths, emit });
    assert.equal(first.outcome, "migrated");
    assert.equal(emitted.length, 1);

    const beforeStartup = await readFile(
      join(paths.xdgLogDir, "repo-repo-log", "startup-1.json"),
      "utf8",
    );
    const second = await migrateToXdg({ fs: realFs, paths, emit });
    assert.equal(second.outcome, "already-xdg");
    assert.equal(emitted.length, 1, "second run must not re-emit the migration event");
    const afterStartup = await readFile(
      join(paths.xdgLogDir, "repo-repo-log", "startup-1.json"),
      "utf8",
    );
    assert.equal(afterStartup, beforeStartup);
  });
});

test("integration: one-way — no legacy dir left behind after migration", async () => {
  await withTempRoot(async (root) => {
    const { paths, repoRoot, home } = await makeLegacyLayout(root);
    await migrateToXdg({ fs: realFs, paths, emit: () => {} });
    await assert.rejects(() => stat(join(repoRoot, ".bakudo", "log")));
    await assert.rejects(() => stat(join(home, ".bakudo", "log")));
    await assert.rejects(() => stat(join(home, ".bakudo", "spans")));
  });
});

test("integration: fresh install with no legacy state stamps marker + emits nothing", async () => {
  await withTempRoot(async (root) => {
    const home = join(root, "home");
    const paths: MigrationPaths = {
      repoRoot: join(root, "repo"),
      home,
      xdgLogDir: join(home, ".local", "share", "bakudo", "log"),
    };
    await mkdir(paths.repoRoot, { recursive: true });
    await mkdir(home, { recursive: true });
    const emitted: SessionEventEnvelope[] = [];
    const result = await migrateToXdg({
      fs: realFs,
      paths,
      emit: (env) => emitted.push(env),
    });
    assert.equal(result.outcome, "already-xdg");
    assert.equal(emitted.length, 0, "fresh install emits nothing");
    await assert.doesNotReject(() => stat(join(paths.xdgLogDir, MIGRATION_MARKER_FILENAME)));
  });
});
