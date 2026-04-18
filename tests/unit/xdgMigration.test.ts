/**
 * Phase 6 Wave 6e PR16 — `.bakudo/` → XDG migration unit tests.
 *
 * Covers detector, migrator, idempotence, event emission, failure modes.
 * Uses an in-memory fake MigrationFs so tests are filesystem-free.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  MIGRATION_MARKER_FILENAME,
  MIGRATION_V1_TO_V2_SKIPPED_KIND,
  buildMigrationEventEnvelope,
  detectLegacyLayout,
  legacySourcesFor,
  migrateToXdg,
  type MigrationFs,
  type MigrationPaths,
} from "../../src/host/xdgMigration.js";
import type { SessionEventEnvelope } from "../../src/protocol.js";

// ---------------------------------------------------------------------------
// In-memory fs fake
// ---------------------------------------------------------------------------

type FakeNode = { kind: "dir" } | { kind: "file"; data: string };

const makeFakeFs = (initial: Record<string, FakeNode> = {}) => {
  const tree = new Map<string, FakeNode>(Object.entries(initial));
  const renames: Array<{ from: string; to: string }> = [];
  const fs: MigrationFs = {
    stat: async (p) => {
      const node = tree.get(p);
      if (node === undefined) return null;
      return { isDirectory: () => node.kind === "dir" };
    },
    mkdir: async (p, opts) => {
      if (tree.has(p)) return;
      if (opts.recursive) {
        const parts = p.split("/").filter((s) => s.length > 0);
        let acc = "";
        for (const part of parts) {
          acc = `${acc}/${part}`;
          if (!tree.has(acc)) tree.set(acc, { kind: "dir" });
        }
      } else {
        tree.set(p, { kind: "dir" });
      }
    },
    rename: async (src, dst) => {
      const node = tree.get(src);
      if (node === undefined) throw new Error(`ENOENT: ${src}`);
      const toMove: Array<[string, FakeNode]> = [];
      for (const [key, val] of tree.entries()) {
        if (key === src || key.startsWith(`${src}/`)) {
          toMove.push([key, val]);
        }
      }
      for (const [key] of toMove) tree.delete(key);
      for (const [key, val] of toMove) {
        const newKey = key === src ? dst : `${dst}${key.slice(src.length)}`;
        tree.set(newKey, val);
      }
      renames.push({ from: src, to: dst });
    },
    writeFile: async (p, data) => {
      tree.set(p, { kind: "file", data });
    },
    exists: async (p) => tree.has(p),
  };
  return { fs, tree, renames };
};

const paths: MigrationPaths = {
  repoRoot: "/repo",
  home: "/home/al",
  xdgLogDir: "/home/al/.local/share/bakudo/log",
};

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

test("detectLegacyLayout: returns xdg when marker exists", async () => {
  const { fs } = makeFakeFs({
    [`/home/al/.local/share/bakudo/log/${MIGRATION_MARKER_FILENAME}`]: {
      kind: "file",
      data: "",
    },
    // Even with stale legacy dir present, marker wins.
    "/repo/.bakudo/log": { kind: "dir" },
  });
  const result = await detectLegacyLayout(fs, paths);
  assert.equal(result.layout, "xdg");
  assert.deepEqual(result.legacyPaths, []);
});

test("detectLegacyLayout: returns legacy when repo-local .bakudo/log exists", async () => {
  const { fs } = makeFakeFs({
    "/repo/.bakudo/log": { kind: "dir" },
  });
  const result = await detectLegacyLayout(fs, paths);
  assert.equal(result.layout, "legacy");
  assert.deepEqual(result.legacyPaths, ["/repo/.bakudo/log"]);
});

test("detectLegacyLayout: returns xdg when no legacy dirs and no marker", async () => {
  const { fs } = makeFakeFs({});
  const result = await detectLegacyLayout(fs, paths);
  assert.equal(result.layout, "xdg");
  assert.deepEqual(result.legacyPaths, []);
});

test("detectLegacyLayout: picks up all three canonical legacy sources", async () => {
  const { fs } = makeFakeFs({
    "/repo/.bakudo/log": { kind: "dir" },
    "/home/al/.bakudo/log": { kind: "dir" },
    "/home/al/.bakudo/spans": { kind: "dir" },
  });
  const result = await detectLegacyLayout(fs, paths);
  assert.equal(result.layout, "legacy");
  assert.deepEqual(result.legacyPaths, [
    "/repo/.bakudo/log",
    "/home/al/.bakudo/log",
    "/home/al/.bakudo/spans",
  ]);
});

test("legacySourcesFor: documents the canonical source tuple", () => {
  assert.deepEqual(legacySourcesFor(paths), [
    "/repo/.bakudo/log",
    "/home/al/.bakudo/log",
    "/home/al/.bakudo/spans",
  ]);
});

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

test("migrateToXdg: moves user-global log dirs, leaves repo-local state alone", async () => {
  const { fs, tree } = makeFakeFs({
    // User-global (should move):
    "/repo/.bakudo/log": { kind: "dir" },
    "/repo/.bakudo/log/startup-123.json": { kind: "file", data: "{}" },
    "/home/al/.bakudo/log": { kind: "dir" },
    "/home/al/.bakudo/spans": { kind: "dir" },
    // Repo-local (MUST stay put):
    "/repo/.bakudo/config.json": { kind: "file", data: "{}" },
    "/repo/.bakudo/host-state.json": { kind: "file", data: "{}" },
    "/repo/.bakudo/sessions": { kind: "dir" },
    "/repo/.bakudo/sessions/index.json": { kind: "file", data: "{}" },
    "/repo/.bakudo/approvals.jsonl": { kind: "file", data: "" },
  });
  const emitted: SessionEventEnvelope[] = [];
  const result = await migrateToXdg({
    fs,
    paths,
    emit: (env) => emitted.push(env),
  });
  assert.equal(result.outcome, "migrated");
  assert.equal(result.migratedPaths.length, 3);
  // Repo-local: untouched.
  assert.ok(tree.has("/repo/.bakudo/config.json"));
  assert.ok(tree.has("/repo/.bakudo/host-state.json"));
  assert.ok(tree.has("/repo/.bakudo/sessions"));
  assert.ok(tree.has("/repo/.bakudo/sessions/index.json"));
  assert.ok(tree.has("/repo/.bakudo/approvals.jsonl"));
  // User-global dirs: gone from source.
  assert.ok(!tree.has("/repo/.bakudo/log"));
  assert.ok(!tree.has("/home/al/.bakudo/log"));
  assert.ok(!tree.has("/home/al/.bakudo/spans"));
  // Destination received the payload with children preserved.
  assert.ok(tree.has("/home/al/.local/share/bakudo/log/repo-repo-log"));
  assert.ok(tree.has("/home/al/.local/share/bakudo/log/repo-repo-log/startup-123.json"));
  assert.ok(tree.has("/home/al/.local/share/bakudo/log/log-legacy"));
  assert.ok(tree.has("/home/al/.local/share/bakudo/log/spans-legacy"));
  // Marker written.
  assert.ok(tree.has(`/home/al/.local/share/bakudo/log/${MIGRATION_MARKER_FILENAME}`));
});

test("migrateToXdg: emits exactly one host.event_skipped envelope on success", async () => {
  const { fs } = makeFakeFs({
    "/repo/.bakudo/log": { kind: "dir" },
  });
  const emitted: SessionEventEnvelope[] = [];
  await migrateToXdg({ fs, paths, emit: (env) => emitted.push(env) });
  assert.equal(emitted.length, 1);
  const env = emitted[0]!;
  assert.equal(env.kind, "host.event_skipped");
  const payload = env.payload as {
    skippedKind?: string;
    migratedPaths?: string[];
    destDir?: string;
    from?: string;
    to?: string;
  };
  assert.equal(payload.skippedKind, MIGRATION_V1_TO_V2_SKIPPED_KIND);
  assert.equal(payload.skippedKind, "host.migration_v1_to_v2");
  assert.deepEqual(payload.migratedPaths, ["/repo/.bakudo/log"]);
  assert.equal(payload.destDir, "/home/al/.local/share/bakudo/log");
  assert.equal(payload.from, "v1");
  assert.equal(payload.to, "v2");
});

test("migrateToXdg: second call is a no-op (idempotence)", async () => {
  const { fs } = makeFakeFs({
    "/repo/.bakudo/log": { kind: "dir" },
  });
  const emitted: SessionEventEnvelope[] = [];
  const first = await migrateToXdg({ fs, paths, emit: (env) => emitted.push(env) });
  assert.equal(first.outcome, "migrated");
  assert.equal(emitted.length, 1);
  const second = await migrateToXdg({ fs, paths, emit: (env) => emitted.push(env) });
  assert.equal(second.outcome, "already-xdg");
  assert.equal(emitted.length, 1, "second call must not re-emit");
  assert.deepEqual(second.migratedPaths, []);
});

test("migrateToXdg: no-op first launch stamps marker, emits nothing", async () => {
  const { fs, tree } = makeFakeFs({});
  const emitted: SessionEventEnvelope[] = [];
  const result = await migrateToXdg({ fs, paths, emit: (env) => emitted.push(env) });
  assert.equal(result.outcome, "already-xdg");
  assert.equal(emitted.length, 0);
  assert.ok(
    tree.has(`/home/al/.local/share/bakudo/log/${MIGRATION_MARKER_FILENAME}`),
    "marker stamped even on fresh install",
  );
});

test("migrateToXdg: destination collision gets -legacy-<n> suffix", async () => {
  const { fs, tree } = makeFakeFs({
    "/repo/.bakudo/log": { kind: "dir" },
    "/home/al/.local/share/bakudo/log/repo-repo-log": { kind: "dir" },
  });
  await migrateToXdg({ fs, paths, emit: () => {} });
  assert.ok(tree.has("/home/al/.local/share/bakudo/log/repo-repo-log"));
  assert.ok(tree.has("/home/al/.local/share/bakudo/log/repo-repo-log-legacy-1"));
});

test("migrateToXdg: rename failure leaves marker UNwritten so next launch retries", async () => {
  const { fs, tree } = makeFakeFs({
    "/repo/.bakudo/log": { kind: "dir" },
  });
  fs.rename = async (_src, _dst) => {
    throw new Error("EIO: disk failure");
  };
  await assert.rejects(() => migrateToXdg({ fs, paths, emit: () => {} }), /EIO/);
  assert.ok(
    !tree.has(`/home/al/.local/share/bakudo/log/${MIGRATION_MARKER_FILENAME}`),
    "marker must NOT be present after a failed migration",
  );
  assert.ok(tree.has("/repo/.bakudo/log"), "legacy source intact after abort");
});

test("migrateToXdg: emit callback error does not roll back a successful migration", async () => {
  const { fs, tree } = makeFakeFs({
    "/repo/.bakudo/log": { kind: "dir" },
  });
  const result = await migrateToXdg({
    fs,
    paths,
    emit: () => {
      throw new Error("sink broke");
    },
  });
  assert.equal(result.outcome, "migrated");
  assert.ok(
    tree.has(`/home/al/.local/share/bakudo/log/${MIGRATION_MARKER_FILENAME}`),
    "marker present — data safe, only diagnostic lost",
  );
});

// ---------------------------------------------------------------------------
// Envelope builder (pure)
// ---------------------------------------------------------------------------

test("buildMigrationEventEnvelope: pins the v2 envelope shape", () => {
  const env = buildMigrationEventEnvelope({
    sessionId: "bakudo-bootstrap",
    migratedPaths: ["/repo/.bakudo/log"],
    destDir: "/home/al/.local/share/bakudo/log",
    timestamp: "2026-04-18T12:00:00.000Z",
  });
  assert.equal(env.schemaVersion, 2);
  assert.equal(env.kind, "host.event_skipped");
  assert.equal(env.actor, "host");
  assert.equal(env.sessionId, "bakudo-bootstrap");
  assert.equal(env.timestamp, "2026-04-18T12:00:00.000Z");
  const payload = env.payload as {
    skippedKind: string;
    migratedPaths: string[];
    destDir: string;
    from: string;
    to: string;
  };
  assert.equal(payload.skippedKind, "host.migration_v1_to_v2");
  assert.deepEqual(payload.migratedPaths, ["/repo/.bakudo/log"]);
  assert.equal(payload.from, "v1");
  assert.equal(payload.to, "v2");
});
