#!/usr/bin/env node

import { chmod } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const executableOutputs = [
  "dist/src/cli.js",
  "dist/src/workerCli.js",
];

for (const relativePath of executableOutputs) {
  const absolutePath = resolve(rootDir, relativePath);
  await chmod(absolutePath, 0o755);
}
