import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { stdoutWrite } from "./io.js";
import { promptForApproval, repoRootFor } from "./orchestration.js";
import type { HostCliArgs } from "./parsing.js";

export const buildAgentsTemplate = (repoRoot: string): string =>
  [
    "# AGENTS.md",
    "",
    "## Bakudo Workflow",
    "",
    "Use `bakudo` as a host control plane over `abox` sandboxes.",
    "",
    "- `bakudo` interactive shell: assistant-style workflow with persisted sessions",
    "- `bakudo run --mode build`: code-changing work in sandbox",
    "- `bakudo run --mode plan`: read-only planning and exploration",
    "- `bakudo sessions`: browse prior sessions",
    "- `bakudo sandbox <session> [task]`: inspect the underlying abox dispatch metadata",
    "",
    "## Safety",
    "",
    "- All repository mutation should happen inside `abox` sandboxes",
    "- Prefer `plan` mode for discovery and review",
    "- `build` mode may request approval before dispatching dangerous-skip-permissions workers",
    "",
    "## Review",
    "",
    "- Use `bakudo review <session> [task]` for reviewed outcomes",
    "- Use `bakudo logs <session> [task]` for event streams",
    "- Use `bakudo sandbox <session> [task]` to inspect sandbox task IDs and dispatch commands",
    "",
    `Generated for repo root: ${repoRoot}`,
    "",
  ].join("\n");

export const runInit = async (args: HostCliArgs): Promise<number> => {
  const repoRoot = repoRootFor(args.repo);
  const target = join(repoRoot, "AGENTS.md");
  let exists = false;
  try {
    await access(target);
    exists = true;
  } catch {
    exists = false;
  }

  if (exists && !args.yes) {
    const approved = await promptForApproval(`Overwrite ${target}?`);
    if (!approved) {
      stdoutWrite("Init cancelled.\n");
      return 2;
    }
  }

  await writeFile(target, buildAgentsTemplate(repoRoot), "utf8");
  stdoutWrite(`Wrote ${target}\n`);
  return 0;
};
