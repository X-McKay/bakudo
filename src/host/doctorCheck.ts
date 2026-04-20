/**
 * Pure check functions used by `bakudo doctor`. Each exported helper
 * produces a {@link DoctorCheckResult}; doctor.ts composes them into the
 * human + JSON envelopes.
 *
 * All functions in this module are synchronous and side-effect-free
 * except where explicitly noted — the filesystem write probe and abox
 * spawn live in separate modules so this file stays easily unit-testable.
 */

import { access, constants, mkdir, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";

import { xdgKeybindingsPath } from "./keybindings/userBindings.js";

/**
 * Verdicts ordered by severity. "pass" is the baseline; "warn" surfaces
 * remediation hints but does not exit non-zero; "fail" exits non-zero.
 */
export type DoctorStatus = "pass" | "warn" | "fail";

export type DoctorCheckResult = {
  name: string;
  status: DoctorStatus;
  summary: string;
  detail?: string;
  remediation?: string;
};

/**
 * Parse a semver-ish string (`vX.Y.Z`, `X.Y.Z`, `X.Y`) into a tuple of
 * integers. Returns `null` if the leading token is not a number.
 */
export const parseSemverMajor = (version: string): number | null => {
  const trimmed = version.trim().replace(/^v/iu, "");
  const first = trimmed.split(/[.-]/u)[0];
  if (first === undefined) {
    return null;
  }
  const n = Number.parseInt(first, 10);
  return Number.isFinite(n) ? n : null;
};

/**
 * The `node` field in `.mise.toml` is declared as `node = "22"`. We accept
 * either a bare major or a `^<maj>.<min>` range from `engines.node`.
 */
export const checkNodeVersion = (input: {
  runtime: string;
  required: number;
}): DoctorCheckResult => {
  const runtimeMajor = parseSemverMajor(input.runtime);
  if (runtimeMajor === null) {
    return {
      name: "node-version",
      status: "warn",
      summary: `Could not parse Node runtime version "${input.runtime}".`,
    };
  }
  if (runtimeMajor < input.required) {
    return {
      name: "node-version",
      status: "fail",
      summary: `Node ${input.runtime} is below required major ${input.required}.`,
      remediation: `Install Node ${input.required} or later (see .mise.toml).`,
    };
  }
  return {
    name: "node-version",
    status: "pass",
    summary: `Node ${input.runtime} (>= ${input.required}).`,
  };
};

/**
 * Check whether `<repoRoot>/.bakudo/` is writeable. If the directory
 * doesn't exist we try to create it — a freshly-cloned repo should be
 * able to bootstrap state without manual setup.
 */
export const checkRepoWriteability = async (repoRoot: string): Promise<DoctorCheckResult> => {
  const dir = join(repoRoot, ".bakudo");
  try {
    await mkdir(dir, { recursive: true });
    const pid = (globalThis as unknown as { process?: { pid?: number } }).process?.pid ?? 0;
    const probe = join(dir, `.doctor-probe-${pid}-${Date.now()}`);
    await writeFile(probe, "", { flag: "w" });
    await unlink(probe);
    return {
      name: "repo-writeability",
      status: "pass",
      summary: `${dir} is writeable.`,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      name: "repo-writeability",
      status: "fail",
      summary: `${dir} is not writeable.`,
      detail: msg,
      remediation: `Ensure you can write to ${dir} or re-run from a repo you own.`,
    };
  }
};

export type TerminalCapability = {
  isTty: boolean;
  supportsAnsi: boolean;
  noColor: boolean;
  colorfgbg?: string;
  term?: string;
};

/**
 * Probe the terminal capability surface without touching the process
 * environment directly — takes an `env`-like record for ease of testing.
 */
export const describeTerminalCapability = (input: {
  isTTY: boolean;
  env: Record<string, string | undefined>;
}): TerminalCapability => {
  const noColor = input.env.NO_COLOR !== undefined;
  const supportsAnsi = input.isTTY && !noColor;
  const result: TerminalCapability = {
    isTty: input.isTTY,
    supportsAnsi,
    noColor,
  };
  if (input.env.COLORFGBG !== undefined) {
    result.colorfgbg = input.env.COLORFGBG;
  }
  if (input.env.TERM !== undefined) {
    result.term = input.env.TERM;
  }
  return result;
};

export const checkTerminalCapability = (input: {
  isTTY: boolean;
  env: Record<string, string | undefined>;
}): DoctorCheckResult => {
  const cap = describeTerminalCapability(input);
  const parts = [`tty=${cap.isTty}`, `ansi=${cap.supportsAnsi}`, `no_color=${cap.noColor}`];
  if (cap.term !== undefined) {
    parts.push(`term=${cap.term}`);
  }
  if (cap.colorfgbg !== undefined) {
    parts.push(`colorfgbg=${cap.colorfgbg}`);
  }
  return {
    name: "terminal-capability",
    status: "pass",
    summary: parts.join(", "),
  };
};

/**
 * Verify the XDG keybindings path. Returns a pass result regardless of
 * whether the file exists — a missing user overrides file is the default.
 * Exists-ness is reported in `detail` so JSON consumers can act on it.
 */
export const checkKeybindingsPath = async (
  path: string = xdgKeybindingsPath(),
): Promise<DoctorCheckResult & { exists: boolean }> => {
  let exists = false;
  try {
    await access(path, constants.F_OK);
    exists = true;
  } catch {
    exists = false;
  }
  const base: DoctorCheckResult & { exists: boolean } = {
    name: "keybindings-path",
    status: "pass",
    summary: `${path} ${exists ? "(exists)" : "(not written — using shipped defaults)"}`,
    exists,
  };
  if (exists) {
    base.detail = "user overrides loaded on next interactive session";
  }
  return base;
};

export type RendererBackendName = "ink" | "plain" | "json";

/**
 * Map a `RendererBackend` instance to a short name. We avoid importing
 * the concrete classes directly (circular-import risk) by probing the
 * constructor name.
 */
export const rendererBackendName = (
  backend: { constructor?: { name?: string } } | null | undefined,
): RendererBackendName => {
  const raw = backend?.constructor?.name ?? "";
  if (raw === "JsonBackend") {
    return "json";
  }
  if (raw === "InkBackend") {
    return "ink";
  }
  return "plain";
};

export const checkRendererBackend = (backend: {
  constructor?: { name?: string };
}): DoctorCheckResult => {
  const name = rendererBackendName(backend);
  return {
    name: "renderer-backend",
    status: "pass",
    summary: `active renderer: ${name}`,
  };
};

/**
 * Format a list of config-cascade layer sources for the doctor output.
 * Takes the layers array produced by `loadConfigCascade` so the same
 * sequence the host would actually read is reported here.
 */
export const checkConfigCascade = (layers: { source: string }[]): DoctorCheckResult => {
  const sources = layers.map((l) => l.source);
  return {
    name: "config-cascade",
    status: "pass",
    summary: `${layers.length} layer(s) read`,
    detail: sources.join(" | "),
  };
};

/**
 * Surface the active agent profile resolved from the merged config. When
 * no explicit agent is active, report `"default"` — matches the UI hint.
 */
export const checkAgentProfile = (agentName?: string): DoctorCheckResult => ({
  name: "agent-profile",
  status: "pass",
  summary: `active agent: ${agentName ?? "default"}`,
});

/**
 * Telemetry status is stubbed until Phase 6. The envelope shape is
 * stable so downstream automation need not re-key when real telemetry
 * wiring lands.
 */
export const checkTelemetry = (): DoctorCheckResult => ({
  name: "telemetry",
  status: "pass",
  summary: "disabled (Phase 6 deliverable)",
});

/**
 * Combine a set of check results into a single status: the worst of
 * ("pass" → "warn" → "fail") wins.
 */
export const worstStatus = (results: DoctorCheckResult[]): DoctorStatus => {
  let worst: DoctorStatus = "pass";
  for (const r of results) {
    if (r.status === "fail") {
      return "fail";
    }
    if (r.status === "warn") {
      worst = "warn";
    }
  }
  return worst;
};
