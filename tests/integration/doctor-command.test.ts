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

const withTempRepo = async (fn: (repoRoot: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "bakudo-doctor-integ-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

// ---------------------------------------------------------------------------
// Envelope shape
// ---------------------------------------------------------------------------

test("runDoctorChecks: envelope has the documented top-level keys", async () => {
  await withTempRepo(async (repoRoot) => {
    const env: DoctorEnvelope = await runDoctorChecks({
      repoRoot,
      env: {},
      nodeRuntime: "v22.11.0",
      stdout: { isTTY: false, write: () => true },
    });
    assert.equal(env.name, "bakudo-doctor");
    assert.equal(typeof env.bakudoVersion, "string");
    assert.ok(["pass", "warn", "fail"].includes(env.status));
    assert.ok(Array.isArray(env.checks));
    assert.ok(env.checks.length >= 10, `expected at least 10 checks, got ${env.checks.length}`);
    assert.equal(env.node.runtime, "v22.11.0");
    assert.equal(env.node.required, 22);
    assert.ok("available" in env.abox);
    assert.ok(["tty", "plain", "json"].includes(env.rendererBackend));
    assert.ok(typeof env.agentProfile === "string");
    assert.ok(Array.isArray(env.configCascadePaths));
    assert.ok(typeof env.keybindingsPath === "string");
    assert.ok(Array.isArray(env.keybindingsConflicts));
    assert.ok("isTty" in env.terminal);
    assert.ok("enabled" in env.telemetry);
  });
});

test("runDoctorChecks: picks 'plain' renderer for non-TTY stdout", async () => {
  await withTempRepo(async (repoRoot) => {
    const env = await runDoctorChecks({
      repoRoot,
      env: {},
      nodeRuntime: "v22.0.0",
      stdout: { isTTY: false, write: () => true },
    });
    assert.equal(env.rendererBackend, "plain");
  });
});

test("runDoctorChecks: picks 'tty' renderer for TTY stdout without NO_COLOR", async () => {
  await withTempRepo(async (repoRoot) => {
    const prior = process.env.NO_COLOR;
    delete process.env.NO_COLOR;
    try {
      const env = await runDoctorChecks({
        repoRoot,
        env: { TERM: "xterm-256color" },
        nodeRuntime: "v22.0.0",
        stdout: { isTTY: true, write: () => true },
      });
      assert.equal(env.rendererBackend, "tty");
    } finally {
      if (prior !== undefined) {
        process.env.NO_COLOR = prior;
      }
    }
  });
});

test("runDoctorChecks: includes repo-writeability PASS for a fresh temp dir", async () => {
  await withTempRepo(async (repoRoot) => {
    const env = await runDoctorChecks({
      repoRoot,
      env: {},
      nodeRuntime: "v22.0.0",
      stdout: { isTTY: false, write: () => true },
    });
    const repoCheck = env.checks.find((c) => c.name === "repo-writeability");
    assert.ok(repoCheck);
    assert.equal(repoCheck.status, "pass");
  });
});

// ---------------------------------------------------------------------------
// formatDoctorReport (human-readable)
// ---------------------------------------------------------------------------

test("formatDoctorReport: human output includes headed sections", async () => {
  await withTempRepo(async (repoRoot) => {
    const env = await runDoctorChecks({
      repoRoot,
      env: {},
      nodeRuntime: "v22.0.0",
      stdout: { isTTY: false, write: () => true },
    });
    const lines = formatDoctorReport(env);
    const body = lines.join("\n");
    assert.match(body, /bakudo doctor/u);
    assert.match(body, /Checks/u);
    assert.match(body, /Environment/u);
    assert.match(body, /node runtime:/u);
    assert.match(body, /renderer backend:/u);
    assert.match(body, /config layers:/u);
  });
});

test("formatDoctorReport: prefixes each check with a status badge", async () => {
  await withTempRepo(async (repoRoot) => {
    const env = await runDoctorChecks({
      repoRoot,
      env: {},
      nodeRuntime: "v22.0.0",
      stdout: { isTTY: false, write: () => true },
    });
    const lines = formatDoctorReport(env);
    const passCount = lines.filter((l) => l.includes("[OK]")).length;
    // At minimum the overall badge + several PASS checks.
    assert.ok(passCount >= 2, `expected at least 2 PASS lines, got ${passCount}`);
  });
});

// ---------------------------------------------------------------------------
// runDoctorCommand (end-to-end with captured stdout)
// ---------------------------------------------------------------------------

test("runDoctorCommand (plain): writes human-readable report and returns exit 0/1", async () => {
  await withTempRepo(async (repoRoot) => {
    const cap = capture();
    const result = await withCapturedStdout(cap.writer, () =>
      runDoctorCommand({
        args: [],
        repoRoot,
        env: {},
        nodeRuntime: "v22.0.0",
        stdout: { isTTY: false, write: () => true },
      }),
    );
    assert.ok(cap.chunks.join("").includes("bakudo doctor"));
    // Exit code depends on whether abox is installed; accept 0 or 1.
    assert.ok([0, 1].includes(result.exitCode));
    assert.equal(result.envelope.name, "bakudo-doctor");
  });
});

test("runDoctorCommand (json): writes a single JSON line matching the envelope shape", async () => {
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
    const body = cap.chunks.join("");
    // Should be exactly one JSON object on one line + trailing newline.
    const trimmed = body.trim();
    assert.ok(trimmed.startsWith("{"));
    const parsed = JSON.parse(trimmed) as DoctorEnvelope;
    assert.equal(parsed.name, "bakudo-doctor");
    // JSON envelope shape per `05-…hardening.md:462-464`.
    assert.ok("node" in parsed);
    assert.ok("abox" in parsed);
    assert.ok("rendererBackend" in parsed);
    assert.ok("agentProfile" in parsed);
    assert.ok("configCascadePaths" in parsed);
    assert.ok("keybindingsPath" in parsed);
    assert.ok("keybindingsConflicts" in parsed);
  });
});

test("runDoctorCommand (json with --json alias): matches --output-format=json", async () => {
  await withTempRepo(async (repoRoot) => {
    const cap = capture();
    await withCapturedStdout(cap.writer, () =>
      runDoctorCommand({
        args: ["--json"],
        repoRoot,
        env: {},
        nodeRuntime: "v22.0.0",
        stdout: { isTTY: false, write: () => true },
      }),
    );
    const trimmed = cap.chunks.join("").trim();
    const parsed = JSON.parse(trimmed) as DoctorEnvelope;
    assert.equal(parsed.name, "bakudo-doctor");
  });
});
