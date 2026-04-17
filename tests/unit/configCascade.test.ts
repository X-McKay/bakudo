import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  BakudoConfigDefaults,
  deepMergeConfig,
  loadConfigCascade,
  xdgConfigPath,
} from "../../src/host/config.js";

const createTempDir = async (prefix: string): Promise<string> =>
  mkdtemp(join(tmpdir(), `bakudo-${prefix}-`));

test("deepMergeConfig: nested objects are merged", () => {
  const base = { mode: "standard" as const };
  const layer = { logLevel: "debug" as const };
  const result = deepMergeConfig(base, layer);
  assert.equal(result.mode, "standard");
  assert.equal(result.logLevel, "debug");
});

test("deepMergeConfig: primitives — last non-undefined wins", () => {
  const result = deepMergeConfig({ mode: "standard" }, { mode: "plan" }, { mode: "autopilot" });
  assert.equal(result.mode, "autopilot");
});

test("deepMergeConfig: retryDelays replaces (does not concatenate)", () => {
  const base = { retryDelays: [50, 100] };
  const layer = { retryDelays: [200, 400] };
  const result = deepMergeConfig(base, layer);
  assert.deepEqual(result.retryDelays, [200, 400]);
});

test("deepMergeConfig: null layers are silently skipped", () => {
  const base = { mode: "standard" as const };
  const result = deepMergeConfig(base, null, null, { logLevel: "error" });
  assert.equal(result.mode, "standard");
  assert.equal(result.logLevel, "error");
});

test("deepMergeConfig: undefined values in layer do not overwrite base", () => {
  const base = { mode: "plan" as const, logLevel: "info" as const };
  const layer = { mode: undefined };
  const result = deepMergeConfig(base, layer);
  assert.equal(result.mode, "plan");
  assert.equal(result.logLevel, "info");
});

test("xdgConfigPath: respects $XDG_CONFIG_HOME", () => {
  const original = process.env.XDG_CONFIG_HOME;
  try {
    process.env.XDG_CONFIG_HOME = "/custom/config";
    assert.equal(xdgConfigPath("bakudo", "config.json"), "/custom/config/bakudo/config.json");
  } finally {
    if (original === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = original;
    }
  }
});

test("xdgConfigPath: defaults to ~/.config when $XDG_CONFIG_HOME unset", () => {
  const original = process.env.XDG_CONFIG_HOME;
  try {
    delete process.env.XDG_CONFIG_HOME;
    const result = xdgConfigPath("bakudo", "config.json");
    assert.ok(result.endsWith("/bakudo/config.json"));
    assert.ok(result.includes(".config"));
  } finally {
    if (original !== undefined) {
      process.env.XDG_CONFIG_HOME = original;
    }
  }
});

test("loadConfigCascade: returns defaults when no config files exist", async () => {
  const repoRoot = await createTempDir("cascade-empty");
  try {
    const { merged, layers } = await loadConfigCascade(repoRoot, {});
    assert.equal(merged.mode, BakudoConfigDefaults.mode);
    assert.equal(merged.autoApprove, BakudoConfigDefaults.autoApprove);
    assert.deepEqual(merged.retryDelays, BakudoConfigDefaults.retryDelays);
    // Only the defaults layer should be present.
    assert.equal(layers[0]?.source, "defaults");
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("loadConfigCascade: repo-local config overrides defaults", async () => {
  const repoRoot = await createTempDir("cascade-repo");
  try {
    await mkdir(join(repoRoot, ".bakudo"), { recursive: true });
    await writeFile(
      join(repoRoot, ".bakudo", "config.json"),
      JSON.stringify({ mode: "plan", logLevel: "debug" }),
      "utf8",
    );
    const { merged } = await loadConfigCascade(repoRoot, {});
    assert.equal(merged.mode, "plan");
    assert.equal(merged.logLevel, "debug");
    // Defaults for non-overridden fields.
    assert.equal(merged.autoApprove, false);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("loadConfigCascade: CLI overrides beat repo-local config", async () => {
  const repoRoot = await createTempDir("cascade-cli");
  try {
    await mkdir(join(repoRoot, ".bakudo"), { recursive: true });
    await writeFile(
      join(repoRoot, ".bakudo", "config.json"),
      JSON.stringify({ mode: "plan" }),
      "utf8",
    );
    const { merged } = await loadConfigCascade(repoRoot, { mode: "autopilot" });
    assert.equal(merged.mode, "autopilot");
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("loadConfigCascade: $BAKUDO_CONFIG override file is respected", async () => {
  const repoRoot = await createTempDir("cascade-envfile");
  const overrideDir = await createTempDir("cascade-override");
  const original = process.env.BAKUDO_CONFIG;
  try {
    const overrideFile = join(overrideDir, "override.json");
    await writeFile(overrideFile, JSON.stringify({ logLevel: "error" }), "utf8");
    process.env.BAKUDO_CONFIG = overrideFile;
    const { merged } = await loadConfigCascade(repoRoot, {});
    assert.equal(merged.logLevel, "error");
  } finally {
    if (original === undefined) {
      delete process.env.BAKUDO_CONFIG;
    } else {
      process.env.BAKUDO_CONFIG = original;
    }
    await rm(repoRoot, { recursive: true, force: true });
    await rm(overrideDir, { recursive: true, force: true });
  }
});

test("loadConfigCascade: invalid layer is skipped with warning", async () => {
  const repoRoot = await createTempDir("cascade-invalid");
  try {
    await mkdir(join(repoRoot, ".bakudo"), { recursive: true });
    await writeFile(join(repoRoot, ".bakudo", "config.json"), JSON.stringify({ mode: 42 }), "utf8");
    const stderrLines: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown): boolean => {
      stderrLines.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      const { merged } = await loadConfigCascade(repoRoot, { logLevel: "debug" });
      // Invalid repo layer is skipped; CLI logLevel still merges.
      assert.equal(merged.logLevel, "debug");
      // Default mode should survive.
      assert.equal(merged.mode, "standard");
      assert.ok(stderrLines.some((line) => line.includes("[bakudo.config]")));
    } finally {
      process.stderr.write = originalWrite;
    }
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("loadConfigCascade: priority order — CLI > override > repo > user > defaults", async () => {
  const repoRoot = await createTempDir("cascade-priority");
  const overrideDir = await createTempDir("cascade-pri-override");
  const userDir = await createTempDir("cascade-pri-user");
  const originalXdg = process.env.XDG_CONFIG_HOME;
  const originalBakudoConfig = process.env.BAKUDO_CONFIG;
  try {
    // Set up user config.
    const userConfigDir = join(userDir, "bakudo");
    await mkdir(userConfigDir, { recursive: true });
    await writeFile(
      join(userConfigDir, "config.json"),
      JSON.stringify({ mode: "plan", logLevel: "info", experimental: true }),
      "utf8",
    );
    process.env.XDG_CONFIG_HOME = userDir;

    // Set up repo-local config.
    await mkdir(join(repoRoot, ".bakudo"), { recursive: true });
    await writeFile(
      join(repoRoot, ".bakudo", "config.json"),
      JSON.stringify({ mode: "autopilot", logLevel: "warning" }),
      "utf8",
    );

    // Set up $BAKUDO_CONFIG override.
    const overrideFile = join(overrideDir, "override.json");
    await writeFile(
      overrideFile,
      JSON.stringify({ mode: "standard", flushIntervalMs: 500 }),
      "utf8",
    );
    process.env.BAKUDO_CONFIG = overrideFile;

    // CLI overrides.
    const { merged } = await loadConfigCascade(repoRoot, { mode: "plan" });

    // CLI > override > repo > user > defaults:
    assert.equal(merged.mode, "plan"); // CLI wins over everything.
    assert.equal(merged.logLevel, "warning"); // repo > user.
    assert.equal(merged.experimental, true); // user > defaults.
    assert.equal(merged.flushIntervalMs, 500); // $BAKUDO_CONFIG > defaults.
  } finally {
    if (originalXdg === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = originalXdg;
    }
    if (originalBakudoConfig === undefined) {
      delete process.env.BAKUDO_CONFIG;
    } else {
      process.env.BAKUDO_CONFIG = originalBakudoConfig;
    }
    await rm(repoRoot, { recursive: true, force: true });
    await rm(overrideDir, { recursive: true, force: true });
    await rm(userDir, { recursive: true, force: true });
  }
});
