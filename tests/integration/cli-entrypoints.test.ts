import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const resolveBuiltFile = (relativePath: string): string => {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "..", "..", relativePath);
};

test("built CLI entrypoints are executable", async () => {
  const cliStat = await stat(resolveBuiltFile("dist/src/cli.js"));
  const workerStat = await stat(resolveBuiltFile("dist/src/workerCli.js"));

  assert.notEqual(cliStat.mode & 0o111, 0, "dist/src/cli.js should be executable");
  assert.notEqual(workerStat.mode & 0o111, 0, "dist/src/workerCli.js should be executable");
});
