import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  appendArtifactRecord,
  ARTIFACT_RECORD_SCHEMA_VERSION,
  type ArtifactRecord,
  artifactIdFor,
  artifactsFilePath,
  listArtifactRecords,
} from "../../src/host/artifactStore.js";

const createTempRoot = (): Promise<string> => mkdtemp(join(tmpdir(), "bakudo-artifacts-"));

const buildRecord = (overrides: Partial<ArtifactRecord> = {}): ArtifactRecord => ({
  schemaVersion: ARTIFACT_RECORD_SCHEMA_VERSION,
  artifactId: artifactIdFor(),
  sessionId: "session-unit",
  turnId: "turn-1",
  attemptId: "attempt-1",
  kind: "result",
  name: "result.json",
  path: "artifacts/attempt-1-result.json",
  createdAt: "2026-04-15T00:00:00.000Z",
  ...overrides,
});

test("artifactIdFor returns `artifact-<epochMs>-<rand8>`", () => {
  const id = artifactIdFor();
  assert.match(id, /^artifact-\d+-[0-9a-f]{8}$/u);
  // Two consecutive IDs must differ even when the timestamp collides.
  const another = artifactIdFor();
  assert.notEqual(id, another);
});

test("listArtifactRecords returns [] for a missing session log", async () => {
  const rootDir = await createTempRoot();
  try {
    const records = await listArtifactRecords(rootDir, "session-missing");
    assert.deepEqual(records, []);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("appendArtifactRecord writes one NDJSON line and listArtifactRecords reads it back", async () => {
  const rootDir = await createTempRoot();
  try {
    const record = buildRecord({ artifactId: "artifact-1-aaaaaaaa" });
    await appendArtifactRecord(rootDir, "session-rt", record);
    const parsed = await listArtifactRecords(rootDir, "session-rt");
    assert.equal(parsed.length, 1);
    assert.deepEqual(parsed[0], record);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("appendArtifactRecord preserves write order across calls", async () => {
  const rootDir = await createTempRoot();
  try {
    const records = [
      buildRecord({ artifactId: "artifact-1-aaaaaaaa", kind: "result" }),
      buildRecord({ artifactId: "artifact-1-bbbbbbbb", kind: "log", name: "worker-output.log" }),
      buildRecord({ artifactId: "artifact-1-cccccccc", kind: "dispatch", name: "dispatch.json" }),
    ];
    for (const record of records) {
      await appendArtifactRecord(rootDir, "session-order", record);
    }
    const parsed = await listArtifactRecords(rootDir, "session-order");
    assert.equal(parsed.length, 3);
    assert.deepEqual(
      parsed.map((entry) => entry.artifactId),
      records.map((entry) => entry.artifactId),
    );
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("listArtifactRecords silently skips malformed NDJSON lines", async () => {
  const rootDir = await createTempRoot();
  try {
    const filePath = artifactsFilePath(rootDir, "session-corrupt");
    await mkdir(dirname(filePath), { recursive: true });
    const good = JSON.stringify(buildRecord({ artifactId: "artifact-1-aaaaaaaa" }));
    await writeFile(filePath, `${good}\n{not-json\n\n${good}\n`, "utf8");
    const parsed = await listArtifactRecords(rootDir, "session-corrupt");
    // Two `good` lines were written; the malformed middle line is dropped.
    assert.equal(parsed.length, 2);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("appendArtifactRecord is append-only: later calls never rewrite existing lines", async () => {
  const rootDir = await createTempRoot();
  try {
    const first = buildRecord({ artifactId: "artifact-1-first" });
    const second = buildRecord({ artifactId: "artifact-1-secnd" });
    await appendArtifactRecord(rootDir, "session-append", first);
    const firstContent = await readFile(artifactsFilePath(rootDir, "session-append"), "utf8");
    await appendArtifactRecord(rootDir, "session-append", second);
    const finalContent = await readFile(artifactsFilePath(rootDir, "session-append"), "utf8");
    // Final content MUST start with the original first-write bytes — no
    // rewrite of the existing line is permitted.
    assert.ok(finalContent.startsWith(firstContent));
    assert.equal(finalContent.trim().split("\n").length, 2);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test("metadata and optional attemptId round-trip cleanly", async () => {
  const rootDir = await createTempRoot();
  try {
    const withMeta = buildRecord({
      artifactId: "artifact-1-metaaaaa",
      metadata: { outcome: "success", extra: [1, 2, 3] },
    });
    // Exercise the "attemptId absent from JSON entirely" branch by building
    // a record without the field via a type-safe omit.
    const withoutAttempt: ArtifactRecord = {
      schemaVersion: ARTIFACT_RECORD_SCHEMA_VERSION,
      artifactId: "artifact-1-noattemp",
      sessionId: "session-meta",
      turnId: "turn-1",
      kind: "log",
      name: "worker-output.log",
      path: "artifacts/worker-output.log",
      createdAt: "2026-04-15T00:00:01.000Z",
    };
    await appendArtifactRecord(rootDir, "session-meta", withMeta);
    await appendArtifactRecord(rootDir, "session-meta", withoutAttempt);

    const parsed = await listArtifactRecords(rootDir, "session-meta");
    assert.equal(parsed.length, 2);
    assert.deepEqual(parsed[0]?.metadata, { outcome: "success", extra: [1, 2, 3] });
    assert.equal(parsed[1]?.attemptId, undefined);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
