import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import type { Dirent } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
  options: { cwd?: string; env?: NodeJS.ProcessEnv; allowedExitCodes?: number[] } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
  try {
    const { stdout, stderr } = await execFileAsync(file, args, {
      cwd: options.cwd,
      env: options.env,
      maxBuffer: 20 * 1024 * 1024,
      timeout: 5 * 60 * 1000,
      windowsHide: true,
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (error) {
    const err = error as {
      code?: number | string;
      stdout?: string;
      stderr?: string;
      message?: string;
    };
    const exitCode =
      typeof err.code === "number" ? err.code : Number.parseInt(String(err.code ?? "1"), 10);
    if (options.allowedExitCodes?.includes(exitCode)) {
      return {
        stdout: err.stdout ?? "",
        stderr: err.stderr ?? "",
        exitCode,
      };
    }
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

const createRepo = async (files: Record<string, string>): Promise<string> => {
  const repoRoot = await mkdtemp(join(tmpdir(), "bakudo-live-apply-"));
  for (const [path, contents] of Object.entries(files)) {
    await writeFile(join(repoRoot, path), contents, "utf8");
  }
  await git(repoRoot, ["init", "-q"]);
  await git(repoRoot, ["config", "user.email", "ci@example.com"]);
  await git(repoRoot, ["config", "user.name", "ci"]);
  await git(repoRoot, ["add", "."]);
  await git(repoRoot, ["commit", "-q", "-m", "init"]);
  return repoRoot;
};

const sessionDirs = async (storageRoot: string): Promise<Dirent[]> =>
  (await readdir(storageRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory());

const loadSingleSession = async (storageRoot: string) => {
  const sessions = await sessionDirs(storageRoot);
  assert.equal(sessions.length, 1, "expected exactly one bakudo session");
  const sessionDir = join(storageRoot, sessions[0]!.name);
  const session = JSON.parse(await readFile(join(sessionDir, "session.json"), "utf8")) as {
    turns: Array<{ attempts: Array<{ status?: string; candidateState?: string }> }>;
  };
  const artifacts = await readJsonLines<{ name: string; path: string }>(join(sessionDir, "artifacts.ndjson"));
  return { sessionDir, session, artifacts };
};

const runBakudoBuild = async (repoRoot: string, prompt: string, allowedExitCodes: number[] = [0]) =>
  runCommand(
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
      aboxBin!,
    ],
    {
      cwd: projectRoot,
      env: process.env,
      allowedExitCodes,
    },
  );

if (!liveE2EEnabled || aboxBin === undefined || aboxBin.length === 0) {
  test.skip("Phase 0 live E2E: dirty non-overlap source edits auto-apply", () => {});
  test.skip("Phase 0 live E2E: overlapping lockfile edits preserve the candidate for confirmation", () => {});
} else {
  test(
    "Phase 0 live E2E: dirty non-overlap source edits auto-apply",
    { timeout: 6 * 60 * 1000 },
    async () => {
      const repoRoot = await createRepo({
        "README.md": ["# Live Apply Fixture", "", "Alpha", "Beta", "Gamma", ""].join("\n"),
      });

      try {
        await writeFile(
          join(repoRoot, "README.md"),
          ["# Live Apply Fixture", "", "Alpha", "Beta", "Gamma local", ""].join("\n"),
          "utf8",
        );

        await runBakudoBuild(
          repoRoot,
          [
            "Update README.md in this repository.",
            "Requirements:",
            "- Change the exact line `Beta` to `Beta candidate`.",
            "- Keep any unrelated local edits intact.",
            "- Run `grep -q 'Beta candidate' README.md` after editing.",
          ].join("\n"),
        );

        assert.equal(
          await readFile(join(repoRoot, "README.md"), "utf8"),
          ["# Live Apply Fixture", "", "Alpha", "Beta candidate", "Gamma local", ""].join("\n"),
        );

        const { session, artifacts } = await loadSingleSession(join(repoRoot, ".bakudo", "sessions"));
        const attempt = session.turns[0]?.attempts[0];
        assert.equal(attempt?.status, "succeeded");
        assert.equal(attempt?.candidateState, "applied");
        assert.ok(artifacts.some((artifact) => artifact.name === "apply-result.json"));
        assert.ok(artifacts.some((artifact) => artifact.name === "apply-verify-result.json"));
      } finally {
        await rm(repoRoot, { recursive: true, force: true });
      }
    },
  );

  test(
    "Phase 0 live E2E: overlapping lockfile edits preserve the candidate for confirmation",
    { timeout: 6 * 60 * 1000 },
    async () => {
      const repoRoot = await createRepo({
        "pnpm-lock.yaml": ["lockfileVersion: '9.0'", "version: 1", "package: demo", ""].join("\n"),
      });

      try {
        await writeFile(
          join(repoRoot, "pnpm-lock.yaml"),
          ["lockfileVersion: '9.0'", "version: local", "package: demo", ""].join("\n"),
          "utf8",
        );

        const build = await runBakudoBuild(
          repoRoot,
          [
            "Update pnpm-lock.yaml in this repository.",
            "Requirements:",
            "- Change the exact line `version: 1` to `version: 2`.",
            "- Do not touch the other lines.",
            "- Run `grep -q 'version: 2' pnpm-lock.yaml` after editing.",
          ].join("\n"),
          [0, 2],
        );

        assert.equal(build.exitCode, 2);
        assert.equal(
          await readFile(join(repoRoot, "pnpm-lock.yaml"), "utf8"),
          ["lockfileVersion: '9.0'", "version: local", "package: demo", ""].join("\n"),
        );

        const { session, artifacts } = await loadSingleSession(join(repoRoot, ".bakudo", "sessions"));
        const attempt = session.turns[0]?.attempts[0];
        assert.equal(attempt?.status, "blocked");
        assert.equal(attempt?.candidateState, "needs_confirmation");
        assert.ok(artifacts.some((artifact) => artifact.name === "apply-conflicts.json"));
      } finally {
        await rm(repoRoot, { recursive: true, force: true });
      }
    },
  );
}
