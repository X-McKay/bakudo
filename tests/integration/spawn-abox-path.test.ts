import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";

import { ABoxAdapter } from "../../src/aboxAdapter.js";
import { buildAboxShellCommandArgs } from "../../src/host/sandboxLifecycle.js";
import { DEFAULT_ENV_POLICY, filterEnv } from "../../src/host/envPolicy.js";

const EPHEMERAL_PROFILE = {
  providerId: "codex",
  resolvedCommand: ["codex", "exec", "--dangerously-bypass-approvals-and-sandbox"],
  sandboxLifecycle: "ephemeral" as const,
  candidatePolicy: "discard" as const,
};

test("F-04 acceptance: adapter spawn with empty allowlist resolves unqualified abox via PATH", async () => {
  const root = await mkdtemp(join(tmpdir(), "bakudo-f04-integration-"));
  const fakeAbox = join(root, "abox");
  const previousPath = process.env.PATH;
  try {
    await writeFile(fakeAbox, "#!/bin/bash\nexit 0\n", "utf8");
    await chmod(fakeAbox, 0o755);
    process.env.PATH = [root, previousPath].filter(Boolean).join(delimiter);

    const filtered = filterEnv(
      process.env as Record<string, string | undefined>,
      DEFAULT_ENV_POLICY,
    );
    assert.equal(filtered.PATH, undefined, "precondition: filterEnv strips PATH");

    const taskId = "bakudo-f-04-integration";
    const adapter = new ABoxAdapter("abox");
    const result = await adapter.spawnLive(
      buildAboxShellCommandArgs(taskId, "echo ok", EPHEMERAL_PROFILE),
      5,
      {},
      filtered,
      { taskId },
    );

    assert.equal(
      result.metadata?.errorType,
      "ok",
      `expected PATH-restored spawn to reach the fake abox binary; got ${JSON.stringify(result)}`,
    );
  } finally {
    if (previousPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = previousPath;
    }
    await rm(root, { recursive: true, force: true });
  }
});
