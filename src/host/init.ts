import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { stdoutWrite } from "./io.js";
import { promptForApproval, repoRootFor } from "./sessionRunSupport.js";
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
    "- `/inspect [summary|review|provenance|artifacts|approvals|logs]`: unified inspect surface",
    "- `/timeline`: turn-level rollback picker (restart a turn and preserve lineage)",
    "- `/allow-all on|off|show`: manage the durable allowlist for the active session",
    "- `/sessions`: browse saved sessions; `/help`: contextual command list",
    "",
    "## Modes",
    "",
    "- `standard`: code-changing work dispatched into an abox sandbox.",
    "  Prompts for approval before risky tool use; approvals are durable.",
    "- `plan`: read-only discovery, review, and exploration. No mutation.",
    "- `autopilot`: same as standard but auto-approves dispatch (for unattended runs).",
    "  Deny rules still win — autopilot never bypasses a `deny`.",
    "",
    "## Safety",
    "",
    "- All repository mutation happens inside `abox` sandboxes.",
    "- Active session state is persisted at `<repo>/.bakudo/host-state.json`.",
    "- **Approvals are durable**: every decision writes an `ApprovalRecord` to",
    "  `<storage>/<session>/approvals.ndjson`; `allow always` appends a rule to",
    "  `<repo>/.bakudo/approvals.jsonl`.",
    "- **Provenance is inspectable**: `/inspect provenance` surfaces the agent",
    "  profile, attempt spec, sandbox task ID, dispatch command array, permission",
    "  rule matches, env allowlist, and exit details.",
    "- **Retry lineage tracked**: attempts link through `TurnTransition` entries so",
    "  `/inspect` and `/timeline` can show the complete retry chain.",
    "- **Follow-up actions are host decisions**: the reviewer produces",
    "  `accept|retry|ask_user|halt|follow_up` recommendations; the host decides.",
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
