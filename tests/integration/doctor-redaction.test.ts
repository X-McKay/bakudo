/**
 * Phase 6 W5 — `bakudo doctor` reports the active redaction policy.
 *
 * Plan 06 §W5 hard rule 384 ("`doctor` should report active redaction / env
 * policy mode"). Asserts both the JSON envelope shape and the human-readable
 * report include the `redaction` section.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { withCapturedStdout } from "../../src/host/io.js";
import {
  formatDoctorReport,
  runDoctorChecks,
  runDoctorCommand,
  type DoctorEnvelope,
} from "../../src/host/commands/doctor.js";
import { DEFAULT_REDACTION_POLICY } from "../../src/host/redaction.js";

const withTempRepo = async (fn: (repoRoot: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "bakudo-doctor-redact-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const capture = (): { writer: { write: (chunk: string) => boolean }; chunks: string[] } => {
  const chunks: string[] = [];
  return {
    chunks,
    writer: {
      write: (chunk: string) => {
        chunks.push(chunk);
        return true;
      },
    },
  };
};

// ---------------------------------------------------------------------------
// Envelope carries redaction section with expected counts
// ---------------------------------------------------------------------------

test("runDoctorChecks: envelope.redaction carries active flag + counts", async () => {
  await withTempRepo(async (repoRoot) => {
    const env: DoctorEnvelope = await runDoctorChecks({
      repoRoot,
      env: {},
      nodeRuntime: "v22.0.0",
      stdout: { isTTY: false, write: () => true },
    });
    assert.equal(env.redaction.active, true);
    assert.equal(env.redaction.envAllowlistCount, DEFAULT_REDACTION_POLICY.envAllowlist.length);
    assert.equal(
      env.redaction.envDenyPatternCount,
      DEFAULT_REDACTION_POLICY.envDenyPatterns.length,
    );
    assert.equal(
      env.redaction.textPatternCount,
      DEFAULT_REDACTION_POLICY.textSecretPatterns.length,
    );
  });
});

// ---------------------------------------------------------------------------
// Human report includes a `redaction:` line
// ---------------------------------------------------------------------------

test("formatDoctorReport: human report includes a 'redaction:' line", async () => {
  await withTempRepo(async (repoRoot) => {
    const env = await runDoctorChecks({
      repoRoot,
      env: {},
      nodeRuntime: "v22.0.0",
      stdout: { isTTY: false, write: () => true },
    });
    const body = formatDoctorReport(env).join("\n");
    assert.match(body, /redaction:/u);
    assert.match(body, /active/u);
    assert.match(body, /text patterns:/u);
    assert.match(body, /env deny patterns:/u);
  });
});

// ---------------------------------------------------------------------------
// JSON envelope end-to-end
// ---------------------------------------------------------------------------

test("runDoctorCommand (json): redaction section is part of the envelope", async () => {
  await withTempRepo(async (repoRoot) => {
    const cap = capture();
    await withCapturedStdout(cap.writer, () =>
      runDoctorCommand({
        args: ["--output-format=json"],
        repoRoot,
        env: {},
        nodeRuntime: "v22.0.0",
        stdout: { isTTY: false, write: () => true },
      }),
    );
    const parsed = JSON.parse(cap.chunks.join("").trim()) as DoctorEnvelope;
    assert.ok("redaction" in parsed, "redaction key must be present");
    assert.equal(parsed.redaction.active, true);
    assert.ok(parsed.redaction.textPatternCount >= 1);
    assert.ok(parsed.redaction.envDenyPatternCount >= 1);
  });
});
