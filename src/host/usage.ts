import { dim, renderCommandHint, renderSection, renderTitle } from "./ansi.js";
import { buildDefaultCommandRegistry } from "./commandRegistryDefaults.js";
import { stdoutWrite } from "./io.js";

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
    renderSection("Install"),
    "  pnpm install:cli",
    "  bakudo",
    "",
    dim("Legacy mode remains available with: bakudo --goal <command>"),
  ];
};

export const printUsage = (): void => {
  const lines = buildUsageLines();
  stdoutWrite(lines.join("\n") + "\n");
};
