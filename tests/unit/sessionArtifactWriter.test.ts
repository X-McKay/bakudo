import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";

import { ArtifactStore } from "../../src/artifactStore.js";
import { readSessionEventLog } from "../../src/host/eventLogWriter.js";
import { listArtifactRecords } from "../../src/host/artifactStore.js";
import { writeSessionArtifact } from "../../src/host/sessionArtifactWriter.js";

const createTempRoot = (): Promise<string> => mkdtemp(join(tmpdir(), "bakudo-session-artifact-"));

test("writeSessionArtifact persists duplicate display names under distinct storage keys", async () => {
  const root = await createTempRoot();
  try {
    const store = new ArtifactStore(root);
    const sessionId = "session-artifacts";
    const turnId = "turn-1";
    const attemptId = "attempt-1";

    await writeSessionArtifact(
      store,
      root,
      sessionId,
      turnId,
      attemptId,
      "report.json",
      '{"index":1}\n',
      "report",
    );
    await writeSessionArtifact(
      store,
      root,
      sessionId,
      turnId,
      attemptId,
      "report.json",
      '{"index":2}\n',
      "report",
    );

    const legacyRecords = await store.listTaskArtifacts(sessionId, attemptId);
    const ndjsonRecords = await listArtifactRecords(root, sessionId);
    assert.equal(legacyRecords.length, 2);
    assert.equal(ndjsonRecords.length, 2);
    assert.equal(legacyRecords[0]?.name, "report.json");
    assert.equal(legacyRecords[1]?.name, "report.json");
    assert.notEqual(legacyRecords[0]?.storageKey, legacyRecords[1]?.storageKey);
    assert.notEqual(ndjsonRecords[0]?.storageKey, ndjsonRecords[1]?.storageKey);
    assert.equal(basename(legacyRecords[0]?.path ?? ""), legacyRecords[0]?.storageKey);
    assert.equal(basename(legacyRecords[1]?.path ?? ""), legacyRecords[1]?.storageKey);
    assert.equal(await readFile(legacyRecords[0]!.path, "utf8"), '{"index":1}\n');
    assert.equal(await readFile(legacyRecords[1]!.path, "utf8"), '{"index":2}\n');

    const envelopes = await readSessionEventLog(root, sessionId);
    const registered = envelopes.filter((envelope) => envelope.kind === "host.artifact_registered");
    assert.equal(registered.length, 2);
    assert.equal(registered[0]?.payload.name, "report.json");
    assert.equal(registered[1]?.payload.name, "report.json");
    assert.notEqual(registered[0]?.payload.storageKey, registered[1]?.payload.storageKey);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("writeSessionArtifact promotes provenance fields into persisted records and event payloads", async () => {
  const root = await createTempRoot();
  try {
    const store = new ArtifactStore(root);
    const sessionId = "session-provenance";
    const turnId = "turn-1";
    const attemptId = "attempt-1";

    await writeSessionArtifact(
      store,
      root,
      sessionId,
      turnId,
      attemptId,
      "summary.md",
      "# Summary\n",
      "summary",
      {
        generatedBy: "guest",
        producer: "guest",
        phase: "execution",
        role: "summary",
        sourceRelativePath: "nested/summary.md",
        originalPath: "nested/summary.md",
      },
    );

    const legacyRecords = await store.listTaskArtifacts(sessionId, attemptId);
    const ndjsonRecords = await listArtifactRecords(root, sessionId);
    assert.equal(legacyRecords.length, 1);
    assert.equal(ndjsonRecords.length, 1);
    const legacy = legacyRecords[0]!;
    const ndjson = ndjsonRecords[0]!;

    assert.notEqual(legacy.storageKey, legacy.name);
    assert.equal(legacy.producer, "guest");
    assert.equal(legacy.phase, "execution");
    assert.equal(legacy.role, "summary");
    assert.equal(legacy.sourceRelativePath, "nested/summary.md");
    assert.equal(ndjson.storageKey, legacy.storageKey);
    assert.equal(ndjson.producer, "guest");
    assert.equal(ndjson.phase, "execution");
    assert.equal(ndjson.role, "summary");
    assert.equal(ndjson.sourceRelativePath, "nested/summary.md");

    const envelopes = await readSessionEventLog(root, sessionId);
    const registered = envelopes.filter((envelope) => envelope.kind === "host.artifact_registered");
    assert.equal(registered.length, 1);
    const payload = registered[0]?.payload as {
      storageKey: string;
      producer: string;
      phase: string;
      role: string;
      sourceRelativePath: string;
    };
    assert.equal(payload.storageKey, legacy.storageKey);
    assert.equal(payload.producer, "guest");
    assert.equal(payload.phase, "execution");
    assert.equal(payload.role, "summary");
    assert.equal(payload.sourceRelativePath, "nested/summary.md");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
