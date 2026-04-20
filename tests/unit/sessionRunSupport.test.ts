import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  resolveEffectiveAboxBin,
  resolveRuntimeHostArgs,
} from "../../src/host/sessionRunSupport.js";
import type { HostCliArgs } from "../../src/host/parsing.js";

const createExecutable = async (path: string): Promise<void> => {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(path, 0o755);
};

const baseArgs = (repo: string): HostCliArgs => ({
  command: "run",
  goal: "echo hi",
  config: "config/default.json",
  aboxBin: "abox",
  repo,
  mode: "build",
  yes: false,
  shell: "bash",
  timeoutSeconds: 120,
  maxOutputBytes: 256 * 1024,
  heartbeatIntervalMs: 5000,
  killGraceMs: 2000,
  copilot: {},
  experimental: false,
});

test("resolveEffectiveAboxBin: prefers sibling ../abox build when repo root is bakudo", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "bakudo-abox-runtime-"));
  const bakudoRoot = join(workspaceRoot, "bakudo");
  const siblingAbox = join(workspaceRoot, "abox", "target", "release", "abox");
  const nestedAbox = join(bakudoRoot, "abox", "target", "release", "abox");

  await mkdir(bakudoRoot, { recursive: true });
  await createExecutable(siblingAbox);
  await createExecutable(nestedAbox);

  assert.equal(await resolveEffectiveAboxBin(bakudoRoot, "abox"), siblingAbox);
});

test("resolveRuntimeHostArgs: resolves workspace-root ./abox build for default abox", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "bakudo-abox-runtime-"));
  const workspaceAbox = join(workspaceRoot, "abox", "target", "release", "abox");
  await createExecutable(workspaceAbox);

  const resolved = await resolveRuntimeHostArgs(baseArgs(workspaceRoot));
  assert.equal(resolved.aboxBin, workspaceAbox);
});

test("resolveEffectiveAboxBin: preserves explicit overrides", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "bakudo-abox-runtime-"));
  await mkdir(join(workspaceRoot, "bakudo"), { recursive: true });

  assert.equal(
    await resolveEffectiveAboxBin(join(workspaceRoot, "bakudo"), "./tools/abox"),
    "./tools/abox",
  );
  assert.equal(
    await resolveEffectiveAboxBin(join(workspaceRoot, "bakudo"), "/usr/local/bin/abox"),
    "/usr/local/bin/abox",
  );
});
