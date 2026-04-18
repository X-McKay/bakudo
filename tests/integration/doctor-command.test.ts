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
import { DEFAULT_UI_MODE, resetActiveUiMode, setActiveUiMode } from "../../src/host/uiMode.js";

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
// Phase 5 PR14 — reports renderer + keybinding wiring landed
// ---------------------------------------------------------------------------

test("runDoctorChecks: reports the Phase 5 renderer-backend + keybindings checks", async () => {
  await withTempRepo(async (repoRoot) => {
    const env = await runDoctorChecks({
      repoRoot,
      env: {},
      nodeRuntime: "v22.0.0",
      stdout: { isTTY: false, write: () => true },
    });
    // The checks list mentions the renderer-backend probe so missing
    // prerequisites surface clearly (`05-…hardening.md:287-293`).
    const rendererCheck = env.checks.find((c) => c.name === "renderer-backend");
    assert.ok(rendererCheck, "renderer-backend check reported");
    // Keybindings path is present even when no user bindings file exists.
    assert.ok(env.keybindingsPath.length > 0, "keybindings path is non-empty");
    assert.equal(
      Array.isArray(env.keybindingsConflicts),
      true,
      "keybindings conflicts array always populated",
    );
  });
});

test("runDoctorChecks (json envelope): renderer backend is one of the documented values", async () => {
  await withTempRepo(async (repoRoot) => {
    const env = await runDoctorChecks({
      repoRoot,
      env: {},
      nodeRuntime: "v22.0.0",
      stdout: { isTTY: false, write: () => true },
    });
    // The renderer-backend value is the one automation callers match on
    // when deciding whether to pass `--plain` / `--json` in CI.
    assert.ok(["tty", "plain", "json"].includes(env.rendererBackend));
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

// ---------------------------------------------------------------------------
// Phase 6 W1 — UI mode is recorded in the envelope + human report.
// Plan 06 hard rule 3: the current UI mode MUST appear in doctor output so
// bug reports can record which surface the user hit.
// ---------------------------------------------------------------------------

test("runDoctorChecks: envelope.uiMode reflects the active mode (default)", async () => {
  await withTempRepo(async (repoRoot) => {
    resetActiveUiMode();
    const env = await runDoctorChecks({
      repoRoot,
      env: {},
      nodeRuntime: "v22.0.0",
      stdout: { isTTY: false, write: () => true },
    });
    assert.equal(env.uiMode.active, DEFAULT_UI_MODE);
    assert.equal(typeof env.uiMode.description, "string");
    assert.ok(env.uiMode.description.length > 0);
  });
});

test("runDoctorChecks: envelope.uiMode reflects --ui legacy after setActiveUiMode", async () => {
  await withTempRepo(async (repoRoot) => {
    setActiveUiMode("legacy");
    try {
      const env = await runDoctorChecks({
        repoRoot,
        env: {},
        nodeRuntime: "v22.0.0",
        stdout: { isTTY: false, write: () => true },
      });
      assert.equal(env.uiMode.active, "legacy");
      assert.match(env.uiMode.description, /legacy/iu);
    } finally {
      resetActiveUiMode();
    }
  });
});

test("runDoctorChecks: envelope.uiMode reflects --ui preview (stage A)", async () => {
  await withTempRepo(async (repoRoot) => {
    setActiveUiMode("preview");
    try {
      const env = await runDoctorChecks({
        repoRoot,
        env: {},
        nodeRuntime: "v22.0.0",
        stdout: { isTTY: false, write: () => true },
      });
      assert.equal(env.uiMode.active, "preview");
    } finally {
      resetActiveUiMode();
    }
  });
});

test("formatDoctorReport: human report includes a 'ui mode:' line", async () => {
  await withTempRepo(async (repoRoot) => {
    setActiveUiMode("preview");
    try {
      const env = await runDoctorChecks({
        repoRoot,
        env: {},
        nodeRuntime: "v22.0.0",
        stdout: { isTTY: false, write: () => true },
      });
      const body = formatDoctorReport(env).join("\n");
      assert.match(body, /ui mode: preview/u);
    } finally {
      resetActiveUiMode();
    }
  });
});

test("runDoctorCommand (json): ui mode is present in the JSON envelope", async () => {
  await withTempRepo(async (repoRoot) => {
    setActiveUiMode("legacy");
    try {
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
      assert.equal(parsed.uiMode.active, "legacy");
      assert.equal(typeof parsed.uiMode.description, "string");
    } finally {
      resetActiveUiMode();
    }
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

// ---------------------------------------------------------------------------
// Phase 6 W4 — `storage` section surfaces total bytes + active retention.
// Plan 06 lines 276-327. The doctor envelope must carry the section so
// operators can spot growth without running `bakudo cleanup --dry-run`.
// ---------------------------------------------------------------------------

test("runDoctorChecks: envelope.storage carries totalArtifactBytes + retentionPolicy", async () => {
  await withTempRepo(async (repoRoot) => {
    const env = await runDoctorChecks({
      repoRoot,
      env: {},
      nodeRuntime: "v22.0.0",
      stdout: { isTTY: false, write: () => true },
    });
    assert.equal(typeof env.storage.totalArtifactBytes, "number");
    assert.ok(env.storage.totalArtifactBytes >= 0);
    assert.equal(typeof env.storage.storageRoot, "string");
    assert.ok(env.storage.storageRoot.length > 0);
    assert.ok(env.storage.retentionPolicy.intermediateMaxAgeMs > 0);
    assert.ok(env.storage.retentionPolicy.intermediateKinds.length > 0);
    assert.ok(env.storage.retentionPolicy.protectedKinds.length > 0);
  });
});

test("formatDoctorReport: human report includes a 'storage:' line", async () => {
  await withTempRepo(async (repoRoot) => {
    const env = await runDoctorChecks({
      repoRoot,
      env: {},
      nodeRuntime: "v22.0.0",
      stdout: { isTTY: false, write: () => true },
    });
    const body = formatDoctorReport(env).join("\n");
    assert.match(body, /storage:.*MB/u);
    assert.match(body, /retention: intermediate >\d+d/u);
  });
});
