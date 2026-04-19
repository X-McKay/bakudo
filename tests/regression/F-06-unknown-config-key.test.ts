import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runDoctorCommand } from "../../src/host/commands/doctor.js";
import { withCapturedStdout } from "../../src/host/io.js";

type Capture = {
  writer: { write: (chunk: string) => boolean };
  chunks: string[];
};

const capture = (): Capture => {
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

const withIsolatedConfigEnv = async <T>(run: (repoRoot: string) => Promise<T>): Promise<T> => {
  const tempRoot = mkdtempSync(join(tmpdir(), "bakudo-f06-"));
  const xdgConfigHome = join(tempRoot, "xdg");
  mkdirSync(join(xdgConfigHome, "bakudo"), { recursive: true });
  const previousHome = process.env.HOME;
  const previousXdgConfigHome = process.env.XDG_CONFIG_HOME;
  const previousBakudoConfig = process.env.BAKUDO_CONFIG;

  try {
    process.env.HOME = tempRoot;
    process.env.XDG_CONFIG_HOME = xdgConfigHome;
    delete process.env.BAKUDO_CONFIG;
    return await run(tempRoot);
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    if (previousXdgConfigHome === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = previousXdgConfigHome;
    }
    if (previousBakudoConfig === undefined) {
      delete process.env.BAKUDO_CONFIG;
    } else {
      process.env.BAKUDO_CONFIG = previousBakudoConfig;
    }
    rmSync(tempRoot, { recursive: true, force: true });
  }
};

const runExplainConfigDoctor = async (
  repoRoot: string,
  key: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
  const cap = capture();
  try {
    const result = await withCapturedStdout(cap.writer, () =>
      runDoctorCommand({
        args: ["--explain-config", key],
        repoRoot,
        env: {},
        nodeRuntime: "v22.0.0",
      }),
    );
    return { exitCode: result.exitCode, stdout: cap.chunks.join(""), stderr: "" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      exitCode: 1,
      stdout: cap.chunks.join(""),
      stderr: `harness_error: ${message}\n`,
    };
  }
};

test(
  "F-06: doctor --explain-config rejects unknown config keys",
  { concurrency: false },
  async () => {
    const result = await withIsolatedConfigEnv((repoRoot) =>
      runExplainConfigDoctor(repoRoot, "nonsense.bogus"),
    );

    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "harness_error: unknown config key: nonsense.bogus\n");
  },
);

test(
  "F-06: doctor --explain-config still explains valid known keys",
  { concurrency: false },
  async () => {
    const result = await withIsolatedConfigEnv((repoRoot) =>
      runExplainConfigDoctor(repoRoot, "mode"),
    );

    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /^config key: mode$/mu);
    assert.match(result.stdout, /^origin: defaults$/mu);
    assert.match(result.stdout, /^effective value: "standard"$/mu);
  },
);
