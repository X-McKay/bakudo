import { dim, renderCommandHint, renderSection, renderTitle } from "./ansi.js";
import { buildDefaultCommandRegistry } from "./commandRegistryDefaults.js";
import { stdoutWrite } from "./io.js";
import { LEGACY_HIDDEN_IN_HELP } from "./uiMode.js";

const interactiveUsageLines = (): string[] => {
  const registry = buildDefaultCommandRegistry();
  return registry
    .list()
    .filter((spec) => spec.hidden !== true)
    .map((spec) => renderCommandHint(`/${spec.name}`, spec.description));
};

export const buildUsageLines = (): string[] => {
  const interactiveLines = interactiveUsageLines();
  return [
    ...renderTitle("Bakudo", "Host control plane for abox sandboxes."),
    dim("Plan on the host, execute in isolated workers, then review with provenance."),
    "",
    renderSection("Usage"),
    "  bakudo build <goal> [--repo PATH] [--config PATH]",
    "  bakudo plan <goal> [--repo PATH] [--config PATH]",
    "  bakudo run <goal> [--repo PATH] [--config PATH]",
    "  bakudo resume <session-id> [task-id]",
    "  bakudo status [session-id]",
    "  bakudo sessions",
    "  bakudo sandbox <session-id> [task-id]",
    "  bakudo init",
    "  bakudo tasks <session-id>",
    "  bakudo review <session-id> [task-id]",
    "  bakudo logs <session-id> [task-id]",
    "  bakudo inspect <session-id> [summary|review|provenance|artifacts|approvals|sandbox|logs]",
    "  bakudo inspect --session <id> [summary|review|provenance|artifacts|approvals|sandbox|logs]",
    "  bakudo version [--output-format=json]",
    "  bakudo doctor [--output-format=json]",
    "  bakudo usage [--session <id>] [--since <dur>] [--format text|json]",
    "  bakudo chronicle [--since <dur>] [--tool <name>] [--approval denied] [--session <id>]",
    "  bakudo help [<topic>]",
    "  bakudo",
    "    Starts the interactive shell.",
    "",
    renderSection("Quick Start"),
    "  bakudo",
    '  bakudo plan "inspect credential forwarding flow"',
    '  bakudo build "add a failing test for sandbox review output" --yes',
    "",
    renderSection("Interactive Commands"),
    ...interactiveLines,
    "",
    renderSection("Common Options"),
    "  --abox-bin PATH         Override the abox binary",
    "  --storage-root PATH     Persist sessions under this directory",
    "  --mode MODE            Host intent mode: build or plan",
    "  --yes                  Auto-approve sandbox execution in build mode",
    "  --shell SHELL           Shell used by the sandbox worker",
    "  --timeout-seconds N     Worker timeout",
    "  --max-output-bytes N    Captured worker output limit",
    "  --heartbeat-ms N        Worker heartbeat interval",
    "  --kill-grace-ms N       Grace period before SIGKILL on timeout",
    "",
    renderSection("Copilot-Parity Flags"),
    "  -p, --prompt <text>       One-shot prompt. Bakudo runs it and exits.",
    "  --output-format=json      JSONL event stream to stdout (use with -p).",
    "  --allow-all-tools         Force Autopilot mode (auto-approve all tools).",
    "",
    renderSection("Bakudo-Specific Flags"),
    dim("  (not present in public Copilot CLI surface — behavior is bakudo-defined)"),
    "  --stream=on|off           Live stream (default) vs buffered output.",
    "  --plain-diff              Strip ANSI from diff-kind artifacts.",
    "  --no-ask-user             Fail instead of prompting; exit code 2 on gate.",
    "  --max-autopilot-continues=N  Cap unattended Autopilot chains (default 10).",
    "",
    renderSection("Rollout"),
    ...buildRolloutHelpLines(),
    "",
    renderSection("Install"),
    "  curl -fsSL https://raw.githubusercontent.com/X-McKay/bakudo/main/scripts/install.sh | bash",
    "  bakudo doctor",
    "",
    dim("Legacy mode remains available with: bakudo --goal <command>"),
  ];
};

/**
 * Phase 6 W1 — `--ui` help block. Whether `legacy` is listed is gated by
 * {@link LEGACY_HIDDEN_IN_HELP}: Stage B (current) lists it as the
 * documented rollback flag; Stage C flips the constant to `true` so help
 * stops advertising the mode while keeping the flag functional.
 */
const buildRolloutHelpLines = (): string[] => {
  const lines: string[] = [
    "  --ui preview              Opt-in preview of the new host UX (stage A).",
    "  --ui default              Use the new host UX (stage B default).",
  ];
  if (!LEGACY_HIDDEN_IN_HELP) {
    lines.push("  --ui legacy               Fall back to the legacy --goal surface.");
  }
  return lines;
};

export const printUsage = (): void => {
  const lines = buildUsageLines();
  stdoutWrite(lines.join("\n") + "\n");
};
