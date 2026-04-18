import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  loadUserBindings,
  xdgKeybindingsPath,
} from "../../../src/host/keybindings/userBindings.js";

const createTempDir = async (prefix: string): Promise<string> =>
  mkdtemp(join(tmpdir(), `bakudo-${prefix}-`));

const swapEnv = (key: string, value: string | undefined): (() => void) => {
  const original = process.env[key];
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
  return () => {
    if (original === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = original;
    }
  };
};

test("xdgKeybindingsPath: respects XDG_CONFIG_HOME", () => {
  const restore = swapEnv("XDG_CONFIG_HOME", "/custom/config");
  try {
    assert.equal(xdgKeybindingsPath(), "/custom/config/bakudo/keybindings.json");
  } finally {
    restore();
  }
});

test("xdgKeybindingsPath: defaults to ~/.config when XDG_CONFIG_HOME unset", () => {
  const restore = swapEnv("XDG_CONFIG_HOME", undefined);
  try {
    const path = xdgKeybindingsPath();
    assert.ok(path.endsWith("/bakudo/keybindings.json"));
  } finally {
    restore();
  }
});

test("loadUserBindings: returns defaults when file missing", async () => {
  const dir = await createTempDir("kb-missing");
  try {
    const path = join(dir, "no-such-file.json");
    const result = await loadUserBindings(path);
    assert.equal(result.source, "defaults");
    assert.ok(result.blocks.some((b) => b.context === "Composer"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadUserBindings: merges valid user block over defaults", async () => {
  const dir = await createTempDir("kb-valid");
  try {
    await mkdir(join(dir, "bakudo"), { recursive: true });
    const path = join(dir, "bakudo", "keybindings.json");
    await writeFile(
      path,
      JSON.stringify({
        Composer: {
          "ctrl+k": "composer:modelPicker",
        },
      }),
      "utf8",
    );
    const merged = await loadUserBindings(path);
    assert.equal(merged.source, "user+defaults");
    const composer = merged.blocks.find((b) => b.context === "Composer");
    assert.ok(composer);
    assert.equal(composer.bindings["ctrl+k"], "composer:modelPicker");
    // Defaults survive.
    assert.equal(composer.bindings["enter"], "composer:submit");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadUserBindings: invalid JSON falls back to defaults (and warns)", async () => {
  const dir = await createTempDir("kb-invalid-json");
  try {
    await mkdir(join(dir, "bakudo"), { recursive: true });
    const path = join(dir, "bakudo", "keybindings.json");
    await writeFile(path, "{ not json", "utf8");
    const merged = await loadUserBindings(path);
    assert.equal(merged.source, "defaults");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadUserBindings: reserved-key attempt falls back to defaults", async () => {
  const dir = await createTempDir("kb-reserved");
  try {
    await mkdir(join(dir, "bakudo"), { recursive: true });
    const path = join(dir, "bakudo", "keybindings.json");
    await writeFile(
      path,
      JSON.stringify({
        Global: { "ctrl+c": "custom:wipe" },
      }),
      "utf8",
    );
    const stderrLines: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown): boolean => {
      stderrLines.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      const merged = await loadUserBindings(path);
      assert.equal(merged.source, "defaults");
      assert.ok(stderrLines.some((line) => line.includes("[bakudo.keybindings]")));
    } finally {
      process.stderr.write = originalWrite;
    }
    // The reserved default must still be present when no user file exists.
    const clean = await loadUserBindings(join(dir, "nonexistent.json"));
    const cleanGlobal = clean.blocks.find((b) => b.context === "Global");
    assert.ok(cleanGlobal);
    assert.equal(cleanGlobal.bindings["ctrl+c"], "app:interrupt");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
