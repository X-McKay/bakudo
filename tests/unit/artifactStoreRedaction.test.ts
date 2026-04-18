/**
 * Phase 6 W5 — artifact-store redaction-before-persist tests.
 *
 * Plan 06 §W5 hard rule 382: redaction must happen before persistence.
 * Exercised through both the v1 JSON-array store and the v2 NDJSON log.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ArtifactStore } from "../../src/artifactStore.js";
import {
  appendArtifactRecord,
  ARTIFACT_RECORD_SCHEMA_VERSION,
  artifactsFilePath,
  listArtifactRecords,
  type ArtifactRecord,
} from "../../src/host/artifactStore.js";
import { REDACTION_MARKER } from "../../src/host/redaction.js";

const SECRET_GHP = "ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SECRET_SK = "sk-abcdefghijklmnopqrstuvwxyz012345";

const createTempRoot = (): Promise<string> => mkdtemp(join(tmpdir(), "bakudo-redact-"));

// ---------------------------------------------------------------------------
// v1 ArtifactStore.registerArtifact
// ---------------------------------------------------------------------------

test("v1 registerArtifact redacts secret-bearing name / metadata before persisting", async () => {
  const root = await createTempRoot();
  try {
    const store = new ArtifactStore(root);
    await store.registerArtifact({
      artifactId: "a-1",
      sessionId: "session-x",
      kind: "log",
      name: `leaked-${SECRET_GHP}.log`,
      path: `/tmp/${SECRET_SK}/out.log`,
      metadata: {
        GITHUB_TOKEN: "ghp_raw_value_1234567890abcdefghij",
        notes: `observed ${SECRET_GHP} in headers`,
      },
    });
    // Read back from the index file directly — we want to assert the DISK
    // state, not the in-memory return value.
    const content = await readFile(store.artifactFile("session-x"), "utf8");
    assert.ok(!content.includes(SECRET_GHP), `ghp leaked to disk:\n${content}`);
    assert.ok(!content.includes(SECRET_SK), `sk leaked to disk:\n${content}`);
    assert.ok(content.includes(REDACTION_MARKER));

    // Deny-pattern key: the whole VALUE is swapped for the marker.
    const parsed = JSON.parse(content) as Array<{
      metadata?: Record<string, unknown>;
    }>;
    assert.equal(parsed[0]?.metadata?.GITHUB_TOKEN, REDACTION_MARKER);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// v2 appendArtifactRecord
// ---------------------------------------------------------------------------

test("v2 appendArtifactRecord redacts before appending to the NDJSON log", async () => {
  const root = await createTempRoot();
  try {
    const rec: ArtifactRecord = {
      schemaVersion: ARTIFACT_RECORD_SCHEMA_VERSION,
      artifactId: "a-1",
      sessionId: "session-y",
      turnId: "turn-1",
      kind: "log",
      name: `dump-${SECRET_GHP}.log`,
      path: "artifacts/x.log",
      createdAt: "2026-04-15T00:00:00.000Z",
      metadata: {
        SESSION_TOKEN: "s3cret",
        notes: `hint: ${SECRET_SK}`,
      },
    };
    await appendArtifactRecord(root, "session-y", rec);

    const content = await readFile(artifactsFilePath(root, "session-y"), "utf8");
    assert.ok(!content.includes(SECRET_GHP), `ghp leaked to disk:\n${content}`);
    assert.ok(!content.includes(SECRET_SK), `sk leaked to disk:\n${content}`);
    assert.ok(content.includes(REDACTION_MARKER));

    // Round-trip via listArtifactRecords — the stored record must still be
    // shape-valid NDJSON (redaction did not break the schema).
    const records = await listArtifactRecords(root, "session-y");
    assert.equal(records.length, 1);
    const record = records[0];
    assert.ok(record, "record parsed back");
    assert.equal(record.artifactId, "a-1");
    assert.equal(record.metadata?.SESSION_TOKEN, REDACTION_MARKER);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
