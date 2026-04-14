import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdtemp, symlink } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { isMainModule } from "../../src/mainModule.js";

test("isMainModule accepts a direct module path", () => {
  const cliPath = fileURLToPath(new URL("../../src/cli.js", import.meta.url));
  const importMetaUrl = pathToFileURL(cliPath).href;

  assert.equal(isMainModule(importMetaUrl, cliPath), true);
});

test("isMainModule accepts a symlinked executable path", async () => {
  const cliPath = fileURLToPath(new URL("../../src/cli.js", import.meta.url));
  const dir = await mkdtemp(join(tmpdir(), "bakudo-main-module-"));
  const linkedPath = join(dir, "bakudo");
  await symlink(cliPath, linkedPath);
  const importMetaUrl = pathToFileURL(realpathSync(cliPath)).href;

  assert.equal(isMainModule(importMetaUrl, linkedPath), true);
});

test("isMainModule rejects unrelated paths", () => {
  const cliPath = fileURLToPath(new URL("../../src/cli.js", import.meta.url));
  const hostCliPath = fileURLToPath(new URL("../../src/hostCli.js", import.meta.url));
  const importMetaUrl = pathToFileURL(cliPath).href;

  assert.equal(isMainModule(importMetaUrl, hostCliPath), false);
});
