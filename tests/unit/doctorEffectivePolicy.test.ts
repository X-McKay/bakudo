/**
 * Wave 6c PR7 carryover #8 — `bakudo doctor` reports the EFFECTIVE (merged)
 * redaction policy, not the hard-coded default.
 *
 * Before this wave, `doctor.ts` called `summarizeRedactionPolicy(DEFAULT_REDACTION_POLICY)`
 * so user-configured `redaction.extraTextPatterns` / `redaction.extraEnvDenyPatterns`
 * in the config cascade never appeared in the envelope. The fix is covered
 * here by writing a repo config layer with extras and asserting the counts
 * go up.
 *
 * Also covers the new Wave 6c PR7 `telemetry` section (plan line 870):
 * spans-on-disk count, dropped-batch count, OTLP endpoint description.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  formatDoctorReport,
  runDoctorChecks,
  type DoctorEnvelope,
} from "../../src/host/commands/doctor.js";
import { DEFAULT_REDACTION_POLICY } from "../../src/host/redaction.js";

const withTempRepo = async (fn: (repoRoot: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "bakudo-doctor-effective-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

// ---------------------------------------------------------------------------
// Carryover #8: effective-policy counts reflect user-configured extras
// ---------------------------------------------------------------------------

test("runDoctorChecks: extra text patterns in repo config raise the text-pattern count", async () => {
  await withTempRepo(async (repoRoot) => {
    const configDir = join(repoRoot, ".bakudo");
    await mkdir(configDir, { recursive: true });
    await writeFile(
      join(configDir, "config.json"),
      JSON.stringify({ redaction: { extraTextPatterns: [".*mysecret.*"] } }),
      "utf8",
    );
    const env: DoctorEnvelope = await runDoctorChecks({
      repoRoot,
      env: {},
      nodeRuntime: "v22.0.0",
      stdout: { isTTY: false, write: () => true },
    });
    assert.equal(
      env.redaction.textPatternCount,
      DEFAULT_REDACTION_POLICY.textSecretPatterns.length + 1,
    );
  });
});

test("runDoctorChecks: extra env-deny patterns in repo config raise the env-deny count", async () => {
  await withTempRepo(async (repoRoot) => {
    const configDir = join(repoRoot, ".bakudo");
    await mkdir(configDir, { recursive: true });
    await writeFile(
      join(configDir, "config.json"),
      JSON.stringify({
        redaction: {
          extraEnvDenyPatterns: ["^COMPANY_INTERNAL_", "^ACME_SECRET_"],
        },
      }),
      "utf8",
    );
    const env = await runDoctorChecks({
      repoRoot,
      env: {},
      nodeRuntime: "v22.0.0",
      stdout: { isTTY: false, write: () => true },
    });
    assert.equal(
      env.redaction.envDenyPatternCount,
      DEFAULT_REDACTION_POLICY.envDenyPatterns.length + 2,
    );
  });
});

test("runDoctorChecks: with no user config, counts match DEFAULT_REDACTION_POLICY", async () => {
  await withTempRepo(async (repoRoot) => {
    const env = await runDoctorChecks({
      repoRoot,
      env: {},
      nodeRuntime: "v22.0.0",
      stdout: { isTTY: false, write: () => true },
    });
    assert.equal(
      env.redaction.textPatternCount,
      DEFAULT_REDACTION_POLICY.textSecretPatterns.length,
    );
    assert.equal(
      env.redaction.envDenyPatternCount,
      DEFAULT_REDACTION_POLICY.envDenyPatterns.length,
    );
  });
});

// ---------------------------------------------------------------------------
// Wave 6c PR7 — telemetry section (plan line 870)
// ---------------------------------------------------------------------------

test("runDoctorChecks: envelope.telemetry carries spansOnDisk + droppedEventBatches + otlp", async () => {
  await withTempRepo(async (repoRoot) => {
    const env = await runDoctorChecks({
      repoRoot,
      env: {},
      nodeRuntime: "v22.0.0",
      stdout: { isTTY: false, write: () => true },
    });
    assert.equal(env.telemetry.enabled, true);
    assert.equal(typeof env.telemetry.spansOnDisk, "number");
    assert.ok(env.telemetry.spansOnDisk >= 0);
    assert.equal(env.telemetry.droppedEventBatches, 0);
    assert.equal(env.telemetry.otlp.configured, false);
    assert.equal(env.telemetry.otlp.host, undefined);
  });
});

test("runDoctorChecks: OTLP endpoint env surfaces only the host, never the bearer token", async () => {
  await withTempRepo(async (repoRoot) => {
    const env = await runDoctorChecks({
      repoRoot,
      env: {
        OTEL_EXPORTER_OTLP_ENDPOINT: "https://observer.internal.example.com:4318/v1/traces",
        OTEL_EXPORTER_OTLP_HEADERS: "authorization=Bearer s3cr3tToken",
      },
      nodeRuntime: "v22.0.0",
      stdout: { isTTY: false, write: () => true },
    });
    assert.equal(env.telemetry.otlp.configured, true);
    assert.equal(env.telemetry.otlp.host, "observer.internal.example.com:4318");
    const body = JSON.stringify(env);
    assert.ok(!body.includes("s3cr3tToken"));
    assert.ok(!body.includes("Bearer"));
  });
});

test("formatDoctorReport: human report includes a 'telemetry:' line", async () => {
  await withTempRepo(async (repoRoot) => {
    const env = await runDoctorChecks({
      repoRoot,
      env: {},
      nodeRuntime: "v22.0.0",
      stdout: { isTTY: false, write: () => true },
    });
    const body = formatDoctorReport(env).join("\n");
    assert.match(body, /telemetry:/u);
    assert.match(body, /spans on disk: \d+/u);
    assert.match(body, /dropped batches: \d+/u);
    assert.match(body, /OTLP endpoint: no/u);
  });
});

test("formatDoctorReport: telemetry line shows OTLP host when configured", async () => {
  await withTempRepo(async (repoRoot) => {
    const env = await runDoctorChecks({
      repoRoot,
      env: { OTEL_EXPORTER_OTLP_ENDPOINT: "https://otel.example.com/ingest" },
      nodeRuntime: "v22.0.0",
      stdout: { isTTY: false, write: () => true },
    });
    const body = formatDoctorReport(env).join("\n");
    assert.match(body, /OTLP endpoint: yes \(host=otel\.example\.com\)/u);
  });
});
