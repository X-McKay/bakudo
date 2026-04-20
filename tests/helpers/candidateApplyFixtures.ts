import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { captureSourceBaseline } from "../../src/host/sourceBaseline.js";

const execFileAsync = promisify(execFile);

const git = async (cwd: string, args: string[]): Promise<void> => {
  await execFileAsync("git", args, { cwd });
};

export type CandidateFixtureState = "dirty" | "committed" | "mixed";
export type SourceFixtureState = "clean" | "non_overlap" | "overlap";

export type CandidateApplyFixture = {
  rootDir: string;
  repoRoot: string;
  worktreePath: string;
  sandboxTaskId: string;
  sourceBaseline: Awaited<ReturnType<typeof captureSourceBaseline>>;
};

const baseReadme = [
  "# Candidate Apply Fixture",
  "",
  "Alpha",
  "Beta",
  "Gamma",
  "",
].join("\n");

const candidateReadme = [
  "# Candidate Apply Fixture",
  "",
  "Alpha candidate",
  "Beta",
  "Gamma candidate",
  "",
].join("\n");

const sourceNonOverlapReadme = [
  "# Candidate Apply Fixture",
  "",
  "Alpha",
  "Beta source",
  "Gamma",
  "",
].join("\n");

const sourceOverlapReadme = [
  "# Candidate Apply Fixture",
  "",
  "Alpha source",
  "Beta",
  "Gamma",
  "",
].join("\n");

export const withCandidateApplyFixture = async (
  options: {
    candidateState: CandidateFixtureState;
    sourceState: SourceFixtureState;
  },
  run: (fixture: CandidateApplyFixture) => Promise<void>,
): Promise<void> => {
  const rootDir = await mkdtemp(join(tmpdir(), "bakudo-candidate-apply-"));
  try {
    const fixture = await createCandidateApplyFixture(rootDir, options);
    await run(fixture);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
};

export const createCandidateApplyFixture = async (
  rootDir: string,
  options: {
    candidateState: CandidateFixtureState;
    sourceState: SourceFixtureState;
  },
): Promise<CandidateApplyFixture> => {
  const repoRoot = join(rootDir, "repo");
  const sandboxTaskId = "sandbox-task-1";
  const worktreePath = join(rootDir, "worktree-sandbox-task-1");

  await mkdir(join(repoRoot, "src"), { recursive: true });
  await git(repoRoot, ["init"]);
  await git(repoRoot, ["config", "user.email", "bakudo@example.test"]);
  await git(repoRoot, ["config", "user.name", "Bakudo Tests"]);
  await writeFile(join(repoRoot, "README.md"), baseReadme, "utf8");
  await writeFile(join(repoRoot, "src", "module.txt"), "base module\n", "utf8");
  await git(repoRoot, ["add", "README.md", "src/module.txt"]);
  await git(repoRoot, ["commit", "-m", "initial"]);
  await git(repoRoot, ["worktree", "add", "-b", `agent/${sandboxTaskId}`, worktreePath, "HEAD"]);

  switch (options.candidateState) {
    case "dirty":
      await writeFile(join(worktreePath, "README.md"), candidateReadme, "utf8");
      await writeFile(join(worktreePath, "src", "candidate-only.txt"), "dirty candidate file\n", "utf8");
      break;
    case "committed":
      await writeFile(join(worktreePath, "README.md"), candidateReadme, "utf8");
      await writeFile(
        join(worktreePath, "src", "candidate-only.txt"),
        "committed candidate file\n",
        "utf8",
      );
      await git(worktreePath, ["add", "README.md", "src/candidate-only.txt"]);
      await git(worktreePath, ["commit", "-m", "candidate commit"]);
      break;
    case "mixed":
      await writeFile(join(worktreePath, "README.md"), candidateReadme, "utf8");
      await writeFile(
        join(worktreePath, "src", "candidate-only.txt"),
        "committed candidate file\n",
        "utf8",
      );
      await git(worktreePath, ["add", "README.md", "src/candidate-only.txt"]);
      await git(worktreePath, ["commit", "-m", "candidate commit"]);
      await writeFile(join(worktreePath, "src", "module.txt"), "base module\nmixed dirty tail\n", "utf8");
      break;
  }

  const sourceBaseline = await captureSourceBaseline(repoRoot);

  switch (options.sourceState) {
    case "clean":
      break;
    case "non_overlap":
      await writeFile(join(repoRoot, "README.md"), sourceNonOverlapReadme, "utf8");
      await writeFile(join(repoRoot, "src", "local-note.txt"), "source local note\n", "utf8");
      break;
    case "overlap":
      await writeFile(join(repoRoot, "README.md"), sourceOverlapReadme, "utf8");
      break;
  }

  return {
    rootDir,
    repoRoot,
    worktreePath,
    sandboxTaskId,
    sourceBaseline,
  };
};
