/**
 * Spawn-based probes for the `abox` binary. Kept separate from
 * `doctorCheck.ts` so the pure check functions there can be tested
 * without mocking `child_process`.
 */

import { execFile, type ExecFileOptions } from "node:child_process";
import { promisify } from "node:util";

import type { DoctorCheckResult } from "./doctorCheck.js";

/**
 * Simplified signature for the execFile probe. We intentionally keep
 * this narrow (no overloads) so tests can pass a stub without matching
 * the full `promisify(execFile)` overload surface.
 */
export type ExecFileFn = (
  file: string,
  args: readonly string[],
  options: ExecFileOptions & { encoding?: BufferEncoding },
) => Promise<{ stdout: string | Buffer; stderr: string | Buffer }>;

const execFileAsync: ExecFileFn = promisify(execFile) as unknown as ExecFileFn;

export type AboxProbe = {
  available: boolean;
  /** Raw version string reported by `abox --version`, when available. */
  version?: string;
  /** Path or bin name used to locate abox (as passed to the probe). */
  bin: string;
  /**
   * Capabilities version reported by `abox --capabilities`. Falls back to
   * `"v1 (assumed)"` when the flag is not recognized.
   */
  capabilities: string;
  error?: string;
};

/**
 * Probe abox availability and capability surface. Defaults to the short
 * abox command name so the check exercises `$PATH` resolution.
 */
export const probeAbox = async (input: {
  bin?: string;
  execFn?: ExecFileFn;
  timeoutMs?: number;
}): Promise<AboxProbe> => {
  const bin = input.bin ?? "abox";
  const execFn = input.execFn ?? execFileAsync;
  const timeout = input.timeoutMs ?? 2000;
  try {
    const { stdout } = await execFn(bin, ["--version"], {
      timeout,
      windowsHide: true,
      encoding: "utf8",
    });
    const version = String(stdout).trim();
    let capabilities = "v1 (assumed)";
    try {
      const { stdout: capsOut } = await execFn(bin, ["--capabilities"], {
        timeout,
        windowsHide: true,
        encoding: "utf8",
      });
      const caps = String(capsOut).trim();
      if (caps.length > 0) {
        capabilities = caps;
      }
    } catch {
      // Older abox binaries don't support --capabilities; fall back to
      // the "assume v1" contract.
      capabilities = "v1 (assumed)";
    }
    const out: AboxProbe = { available: true, bin, capabilities };
    if (version.length > 0) {
      out.version = version;
    }
    return out;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      available: false,
      bin,
      capabilities: "unknown",
      error: msg,
    };
  }
};

/**
 * Map the raw probe onto a {@link DoctorCheckResult} pair (availability +
 * capabilities) for inclusion in the doctor envelope.
 */
export const aboxProbeToChecks = (probe: AboxProbe): DoctorCheckResult[] => {
  if (!probe.available) {
    const fail: DoctorCheckResult = {
      name: "abox-availability",
      status: "fail",
      summary: `abox binary not found on PATH (tried "${probe.bin}")`,
      remediation:
        "Install abox (cargo install --path abox) or pass --abox-bin to point at an existing binary.",
    };
    if (probe.error !== undefined) {
      fail.detail = probe.error;
    }
    return [
      fail,
      {
        name: "abox-capabilities",
        status: "warn",
        summary: "abox capabilities unknown (binary unavailable)",
      },
    ];
  }
  return [
    {
      name: "abox-availability",
      status: "pass",
      summary: `abox available: ${probe.version ?? "(unknown version)"}`,
      detail: probe.bin,
    },
    {
      name: "abox-capabilities",
      status: "pass",
      summary: probe.capabilities,
    },
  ];
};
