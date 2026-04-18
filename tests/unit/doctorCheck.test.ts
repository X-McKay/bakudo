import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  checkAgentProfile,
  checkConfigCascade,
  checkKeybindingsPath,
  checkNodeVersion,
  checkRepoWriteability,
  checkRendererBackend,
  checkTelemetry,
  checkTerminalCapability,
  describeTerminalCapability,
  parseSemverMajor,
  rendererBackendName,
  worstStatus,
} from "../../src/host/doctorCheck.js";
import {
  aboxProbeToChecks,
  probeAbox,
  type AboxProbe,
  type ExecFileFn,
} from "../../src/host/doctorAboxProbe.js";
import { JsonBackend } from "../../src/host/renderers/jsonBackend.js";
import { PlainBackend } from "../../src/host/renderers/plainBackend.js";
import { TtyBackend } from "../../src/host/renderers/ttyBackend.js";

// ---------------------------------------------------------------------------
// parseSemverMajor
// ---------------------------------------------------------------------------

test("parseSemverMajor accepts v-prefixed and bare forms", () => {
  assert.equal(parseSemverMajor("v22.11.0"), 22);
  assert.equal(parseSemverMajor("22.11.0"), 22);
  assert.equal(parseSemverMajor("V18"), 18);
  assert.equal(parseSemverMajor("abc"), null);
});

// ---------------------------------------------------------------------------
// checkNodeVersion
// ---------------------------------------------------------------------------

test("checkNodeVersion PASS when runtime meets required major", () => {
  const result = checkNodeVersion({ runtime: "v22.11.0", required: 22 });
  assert.equal(result.status, "pass");
  assert.equal(result.name, "node-version");
});

test("checkNodeVersion FAIL when runtime is below required major", () => {
  const result = checkNodeVersion({ runtime: "v18.0.0", required: 22 });
  assert.equal(result.status, "fail");
  assert.ok(result.remediation);
});

test("checkNodeVersion WARN when runtime is unparseable", () => {
  const result = checkNodeVersion({ runtime: "weird", required: 22 });
  assert.equal(result.status, "warn");
});

// ---------------------------------------------------------------------------
// checkRepoWriteability
// ---------------------------------------------------------------------------

test("checkRepoWriteability PASS when .bakudo/ can be created", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bakudo-doctor-"));
  try {
    const result = await checkRepoWriteability(dir);
    assert.equal(result.status, "pass");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// describeTerminalCapability / checkTerminalCapability
// ---------------------------------------------------------------------------

test("describeTerminalCapability honors NO_COLOR", () => {
  const cap = describeTerminalCapability({
    isTTY: true,
    env: { NO_COLOR: "1", TERM: "xterm-256color" },
  });
  assert.equal(cap.noColor, true);
  assert.equal(cap.supportsAnsi, false);
  assert.equal(cap.term, "xterm-256color");
});

test("describeTerminalCapability surfaces COLORFGBG when set", () => {
  const cap = describeTerminalCapability({
    isTTY: true,
    env: { COLORFGBG: "15;0" },
  });
  assert.equal(cap.colorfgbg, "15;0");
  assert.equal(cap.supportsAnsi, true);
});

test("checkTerminalCapability always returns pass (signal-only check)", () => {
  const result = checkTerminalCapability({ isTTY: false, env: {} });
  assert.equal(result.status, "pass");
  assert.match(result.summary, /tty=false/u);
});

// ---------------------------------------------------------------------------
// checkKeybindingsPath
// ---------------------------------------------------------------------------

test("checkKeybindingsPath reports `(not written — using shipped defaults)` when missing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bakudo-keybindings-"));
  const path = join(dir, "missing.json");
  try {
    const result = await checkKeybindingsPath(path);
    assert.equal(result.status, "pass");
    assert.equal(result.exists, false);
    assert.match(result.summary, /not written/u);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("checkKeybindingsPath reports `(exists)` when file is on disk", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bakudo-keybindings-"));
  const path = join(dir, "keybindings.json");
  await writeFile(path, "{}", "utf8");
  try {
    const result = await checkKeybindingsPath(path);
    assert.equal(result.exists, true);
    assert.match(result.summary, /exists/u);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// renderer backend name probe
// ---------------------------------------------------------------------------

// RendererBackend types expose only the `render`/`dispose` surface; the
// check-functions probe `constructor.name`, which is a runtime property of
// the instance. Cast to the structural shape for the assertion.
type BackendCtorProbe = { constructor?: { name?: string } };

test("rendererBackendName identifies TtyBackend as 'tty'", () => {
  const backend = new TtyBackend({ write: () => true, isTTY: true });
  assert.equal(rendererBackendName(backend as unknown as BackendCtorProbe), "tty");
});

test("rendererBackendName identifies PlainBackend as 'plain'", () => {
  const backend = new PlainBackend({ write: () => true });
  assert.equal(rendererBackendName(backend as unknown as BackendCtorProbe), "plain");
});

test("rendererBackendName identifies JsonBackend as 'json'", () => {
  const backend = new JsonBackend({ write: () => true });
  assert.equal(rendererBackendName(backend as unknown as BackendCtorProbe), "json");
});

test("checkRendererBackend wraps the probe into a pass DoctorCheckResult", () => {
  const backend = new PlainBackend({ write: () => true });
  const result = checkRendererBackend(backend as unknown as BackendCtorProbe);
  assert.equal(result.status, "pass");
  assert.match(result.summary, /plain/u);
});

// ---------------------------------------------------------------------------
// config cascade / agent profile / telemetry
// ---------------------------------------------------------------------------

test("checkConfigCascade summarizes layer count + sources", () => {
  const result = checkConfigCascade([
    { source: "defaults" },
    { source: "user" },
    { source: "cli" },
  ]);
  assert.equal(result.status, "pass");
  assert.match(result.summary, /3 layer/u);
  assert.match(result.detail ?? "", /defaults \| user \| cli/u);
});

test("checkAgentProfile defaults to 'default' when no profile active", () => {
  const result = checkAgentProfile();
  assert.match(result.summary, /default/u);
});

test("checkTelemetry reports the Phase-6 stub", () => {
  const result = checkTelemetry();
  assert.equal(result.status, "pass");
  assert.match(result.summary, /Phase 6/u);
});

// ---------------------------------------------------------------------------
// aboxProbeToChecks
// ---------------------------------------------------------------------------

test("aboxProbeToChecks: unavailable → FAIL availability + WARN capabilities", () => {
  const probe: AboxProbe = {
    available: false,
    bin: "abox",
    capabilities: "unknown",
    error: "ENOENT",
  };
  const checks = aboxProbeToChecks(probe);
  assert.equal(checks.length, 2);
  assert.equal(checks[0]!.status, "fail");
  assert.equal(checks[1]!.status, "warn");
});

test("aboxProbeToChecks: available → PASS for both availability + capabilities", () => {
  const probe: AboxProbe = {
    available: true,
    bin: "abox",
    version: "abox 0.1.0",
    capabilities: "v1 (assumed)",
  };
  const checks = aboxProbeToChecks(probe);
  assert.equal(checks[0]!.status, "pass");
  assert.match(checks[0]!.summary, /0\.1\.0/u);
  assert.equal(checks[1]!.status, "pass");
});

// ---------------------------------------------------------------------------
// probeAbox with a stubbed execFn
// ---------------------------------------------------------------------------

const makeExecStub = (
  handler: (args: readonly string[]) => Promise<{ stdout: string; stderr: string }>,
): ExecFileFn =>
  (async (_bin: string, args: readonly string[]) => handler(args)) as unknown as ExecFileFn;

test("probeAbox: falls back to 'v1 (assumed)' when --capabilities is not recognized", async () => {
  const execFn = makeExecStub(async (args) => {
    if (args[0] === "--version") {
      return { stdout: "abox 0.1.0\n", stderr: "" };
    }
    throw new Error("unknown flag --capabilities");
  });
  const result = await probeAbox({ bin: "abox", execFn });
  assert.equal(result.available, true);
  assert.equal(result.version, "abox 0.1.0");
  assert.equal(result.capabilities, "v1 (assumed)");
});

test("probeAbox: returns available=false on spawn failure", async () => {
  const execFn = makeExecStub(async () => {
    throw new Error("ENOENT");
  });
  const result = await probeAbox({ bin: "abox", execFn });
  assert.equal(result.available, false);
  assert.match(result.error ?? "", /ENOENT/u);
});

test("probeAbox: picks up the real --capabilities output when provided", async () => {
  const execFn = makeExecStub(async (args) => {
    if (args[0] === "--version") {
      return { stdout: "abox 0.2.0\n", stderr: "" };
    }
    return { stdout: "v2\n", stderr: "" };
  });
  const result = await probeAbox({ bin: "abox", execFn });
  assert.equal(result.capabilities, "v2");
});

// ---------------------------------------------------------------------------
// worstStatus
// ---------------------------------------------------------------------------

test("worstStatus: all pass → pass", () => {
  assert.equal(
    worstStatus([
      { name: "a", status: "pass", summary: "" },
      { name: "b", status: "pass", summary: "" },
    ]),
    "pass",
  );
});

test("worstStatus: any warn → warn", () => {
  assert.equal(
    worstStatus([
      { name: "a", status: "pass", summary: "" },
      { name: "b", status: "warn", summary: "" },
    ]),
    "warn",
  );
});

test("worstStatus: any fail → fail (dominates warn)", () => {
  assert.equal(
    worstStatus([
      { name: "a", status: "warn", summary: "" },
      { name: "b", status: "fail", summary: "" },
    ]),
    "fail",
  );
});
