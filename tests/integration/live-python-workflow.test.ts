import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import type { Dirent } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

const aboxBin = process.env.BAKUDO_INTEGRATION_ABOX_BIN?.trim();
const liveE2EEnabled = process.env.BAKUDO_INTEGRATION_E2E === "1";
const cliPath = fileURLToPath(new URL("../../src/cli.js", import.meta.url));
const projectRoot = fileURLToPath(new URL("../../..", import.meta.url));
const nodeBin = process.argv[0] ?? "node";

const readJsonLines = async <T>(filePath: string): Promise<T[]> => {
  const content = await readFile(filePath, "utf8");
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as T);
};

const runCommand = async (
  file: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<{ stdout: string; stderr: string }> => {
  try {
    const { stdout, stderr } = await execFileAsync(file, args, {
      cwd: options.cwd,
      env: options.env,
      maxBuffer: 20 * 1024 * 1024,
      timeout: 5 * 60 * 1000,
      windowsHide: true,
    });
    return { stdout, stderr };
  } catch (error) {
    const err = error as {
      code?: number | string;
      stdout?: string;
      stderr?: string;
      message?: string;
    };
    const rendered = [
      `command failed: ${file} ${args.join(" ")}`,
      `code: ${String(err.code ?? "unknown")}`,
      "stdout:",
      err.stdout ?? "",
      "stderr:",
      err.stderr ?? "",
      err.message ?? "",
    ].join("\n");
    throw new Error(rendered);
  }
};

const git = async (repoRoot: string, args: string[]): Promise<void> => {
  await runCommand("git", args, { cwd: repoRoot });
};

const assertGuestToolchain = async (repoRoot: string): Promise<void> => {
  await runCommand(
    aboxBin!,
    [
      "--repo",
      repoRoot,
      "run",
      "--task",
      "live-python-preflight",
      "--ephemeral",
      "--",
      "/bin/sh",
      "-c",
      "command -v claude && command -v python3",
    ],
    {
      cwd: projectRoot,
      env: process.env,
    },
  );
};

const createSeedRepo = async (): Promise<string> => {
  const repoRoot = await mkdtemp(join(tmpdir(), "bakudo-live-python-"));
  await mkdir(join(repoRoot, "tests"), { recursive: true });
  await writeFile(
    join(repoRoot, "README.md"),
    ["# Live Python Workflow", "", "This repo is used for bakudo integration testing.", ""].join(
      "\n",
    ),
    "utf8",
  );
  await writeFile(
    join(repoRoot, "tests", "test_app.py"),
    [
      "import unittest",
      "",
      "from app import greet",
      "",
      "",
      "class GreeterTests(unittest.TestCase):",
      "    def test_greet_normalizes_name(self) -> None:",
      '        self.assertEqual(greet(\"  baKudo   agent  \"), \"Hello, Bakudo Agent!\")',
      "",
      "",
      'if __name__ == \"__main__\":',
      "    unittest.main()",
      "",
    ].join("\n"),
    "utf8",
  );

  await git(repoRoot, ["init", "-q"]);
  await git(repoRoot, ["add", "README.md", "tests/test_app.py"]);
  await runCommand(
    "git",
    ["-c", "user.email=ci@example.com", "-c", "user.name=ci", "commit", "-q", "-m", "init"],
    { cwd: repoRoot },
  );

  return repoRoot;
};

const prompt = [
  "Create the missing `app.py` module for this repository.",
  "Requirements:",
  "- Implement `greet(name: str) -> str`.",
  "- Strip surrounding whitespace from `name`.",
  "- Collapse internal runs of whitespace to a single space.",
  "- Title-case the remaining words.",
  "- Return exactly `Hello, <Name>!`.",
  "- Prepend the exact line `Tiny greeter app used for bakudo integration testing.` to README.md.",
  "- Run `python3 -m unittest discover -s tests -v` until it passes.",
  "- Use only the Python standard library.",
].join("\n");

type ArtifactRecord = {
  name: string;
  path: string;
};

const sessionDirs = async (storageRoot: string): Promise<Dirent[]> =>
  (await readdir(storageRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory());

if (!liveE2EEnabled || aboxBin === undefined || aboxBin.length === 0) {
  test.skip("Phase 0 live E2E: bakudo creates and tests a Python repo via abox", () => {});
} else {
  test(
    "Phase 0 live E2E: bakudo creates and tests a Python repo via abox",
    { timeout: 6 * 60 * 1000 },
    async () => {
      const repoRoot = await createSeedRepo();

      try {
        await assertGuestToolchain(repoRoot);

        await runCommand(
          nodeBin,
          [
            "--no-warnings",
            cliPath,
            "build",
            prompt,
            "--repo",
            repoRoot,
            "--yes",
            "--abox-bin",
            aboxBin,
          ],
          {
            cwd: projectRoot,
            env: process.env,
          },
        );

        const appPy = await readFile(join(repoRoot, "app.py"), "utf8").catch(() => null);
        assert.ok(
          appPy !== null,
          [
            "bakudo reported success but did not create app.py",
            "this indicates the current assistant_job path completed without mutating the repo",
          ].join("; "),
        );
        assert.match(appPy, /def greet\(name: str\) -> str:/u);

        const readme = await readFile(join(repoRoot, "README.md"), "utf8");
        assert.ok(
          readme.startsWith("Tiny greeter app used for bakudo integration testing.\n"),
          "README should start with the exact requested summary line",
        );

        const hostTestRun = await runCommand(
          "python3",
          ["-m", "unittest", "discover", "-s", "tests", "-v"],
          { cwd: repoRoot, env: process.env },
        );
        const hostCombined = `${hostTestRun.stdout}\n${hostTestRun.stderr}`;
        assert.match(hostCombined, /Ran 1 test/u);
        assert.match(hostCombined, /\bOK\b/u);

        const storageRoot = join(repoRoot, ".bakudo", "sessions");
        const sessions = await sessionDirs(storageRoot);
        assert.equal(
          sessions.length,
          1,
          "expected exactly one bakudo session for the isolated repo",
        );

        const sessionDir = join(storageRoot, sessions[0]!.name);
        const artifacts = await readJsonLines<ArtifactRecord>(join(sessionDir, "artifacts.ndjson"));
        const workerOutput = artifacts
          .filter((record) => record.name === "worker-output.log")
          .at(-1);
        assert.ok(workerOutput, "expected a persisted worker-output.log artifact");

        const workerLog = await readFile(join(sessionDir, workerOutput.path), "utf8");
        const resultLine = workerLog
          .split("\n")
          .map((line) => line.trim())
          .find((line) => line.startsWith("BAKUDO_WORKER_RESULT "));
        assert.ok(resultLine, "expected a structured worker result line in worker-output.log");

        const workerResult = JSON.parse(resultLine!.slice("BAKUDO_WORKER_RESULT ".length)) as {
          status?: string;
          stdout?: string;
        };
        assert.equal(workerResult.status, "succeeded");
        assert.match(workerResult.stdout ?? "", /Ran 1 test/u);
        assert.match(workerResult.stdout ?? "", /\bOK\b/u);
      } finally {
        await rm(repoRoot, { recursive: true, force: true });
      }
    },
  );
}
