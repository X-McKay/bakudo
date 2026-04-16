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
    "Use `bakudo` as a host control plane over `abox` sandboxes. Plain text in the",
    "interactive shell continues the active session as a new turn; slash commands",
    "manage sessions, modes, inspection, and approvals.",
    "",
    "- `bakudo`: launch the interactive transcript-first shell",
    "- `/new`: start a fresh session; `/resume [id]`: resume the most recent or named session",
    "- `/mode standard|plan|autopilot`: composer mode (default: standard)",
    "- `/inspect [summary|review|sandbox|artifacts|logs]`: unified inspect surface",
    "- `/sessions`: browse saved sessions; `/help`: contextual command list",
    "",
    "## Modes",
    "",
    "- `standard`: code-changing work dispatched into an ephemeral abox sandbox.",
    "  May prompt for approval before passing dangerous-skip-permissions to the worker.",
    "- `plan`: read-only discovery, review, and exploration. No mutation.",
    "- `autopilot`: same as standard but auto-approves dispatch (for unattended runs).",
    "",
    "## Safety",
    "",
    "- All repository mutation happens inside `abox` sandboxes.",
    "- Active session state is persisted at `<repo>/.bakudo/host-state.json`.",
    "- Provenance (sandbox task IDs, dispatch command, artifact paths) is durable",
    "  and visible via `/inspect sandbox` and `/inspect artifacts`.",
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
