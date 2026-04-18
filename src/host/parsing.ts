import { tryConsumeCopilotFlag } from "./copilotFlagParser.js";
import type { TaskMode } from "../protocol.js";

export type HostCommand =
  | "run"
  | "build"
  | "plan"
  | "resume"
  | "tasks"
  | "review"
  | "logs"
  | "sessions"
  | "sandbox"
  | "status"
  | "init"
  | "help";

/**
 * Copilot-parity flag namespace. Phase 1 PR4 reserved the names; Phase 5 PR11
 * wires the semantics through all three backends.
 *
 * Parity status (see `plans/bakudo-ux/05-rich-tui-and-distribution-hardening.md:441-464`):
 *
 * | Flag | Parity |
 * | --- | --- |
 * | `-p`, `--prompt` | Confirmed Copilot parity (one-shot). |
 * | `--output-format=json` | Confirmed Copilot parity (JSONL stream). |
 * | `--allow-all-tools` | Confirmed Copilot parity (autopilot shortcut). |
 * | `--stream=off` | Bakudo-specific reframe (unverified in public Copilot). |
 * | `--plain-diff` | Bakudo-specific reframe (unverified in public Copilot). |
 * | `--no-ask-user` | Bakudo-specific reframe (unverified in public Copilot). |
 * | `--max-autopilot-continues=N` | Bakudo-original (cap on unattended chains). |
 */
export type CopilotParityFlags = {
  /** `-p`, `--prompt` — one-shot goal source. Confirmed Copilot parity. */
  prompt?: string;
  /** `--stream=off` — buffer until completion. Bakudo-specific. */
  streamOff?: boolean;
  /** `--plain-diff` — strip ANSI from diff artifacts. Bakudo-specific. */
  plainDiff?: boolean;
  /** `--output-format=json` — machine-readable JSONL stream. Confirmed parity. */
  outputFormat?: "json" | "text";
  /** `--allow-all-tools` — forces ComposerMode to "autopilot". Confirmed parity. */
  allowAllTools?: boolean;
  /** `--no-ask-user` — `launchApprovalDialog` throws instead of prompting. Bakudo-specific. */
  noAskUser?: boolean;
  /** `--max-autopilot-continues=N` — bound on unattended continue chains. Bakudo-original. */
  maxAutopilotContinues?: number;
};

/** Default cap on unattended Autopilot continue chains when the flag is unset. */
export const DEFAULT_MAX_AUTOPILOT_CONTINUES = 10 as const;

export type HostCliArgs = {
  command: HostCommand;
  goal?: string;
  sessionId?: string;
  taskId?: string;
  config: string;
  aboxBin: string;
  repo?: string;
  storageRoot?: string;
  mode: TaskMode;
  yes: boolean;
  shell: string;
  timeoutSeconds: number;
  maxOutputBytes: number;
  heartbeatIntervalMs: number;
  killGraceMs: number;
  copilot: CopilotParityFlags;
};

export const HOST_COMMANDS = new Set<HostCommand>([
  "run",
  "build",
  "plan",
  "resume",
  "tasks",
  "review",
  "logs",
  "sessions",
  "sandbox",
  "status",
  "init",
  "help",
]);

export const RUN_COMMANDS = new Set<HostCommand>(["run", "build", "plan"]);
export const SESSION_REQUIRED_COMMANDS = new Set<HostCommand>([
  "resume",
  "tasks",
  "review",
  "logs",
  "sandbox",
]);

export const parsePositiveInteger = (
  value: string | undefined,
  name: string,
  fallback: number,
): number => {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`invalid ${name}: expected positive integer`);
  }
  return parsed;
};

export const readLongFlag = (
  argv: string[],
  index: number,
  flag: string,
): { value: string; consumed: number } => {
  const arg = argv[index];
  if (arg === undefined) {
    throw new Error(`missing argument for ${flag}`);
  }
  if (arg === flag) {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`missing value for ${flag}`);
    }
    return { value, consumed: 2 };
  }

  if (arg.startsWith(`${flag}=`)) {
    return { value: arg.slice(flag.length + 1), consumed: 1 };
  }

  throw new Error(`unexpected flag parser call for ${String(arg)}`);
};

export const parseHostArgs = (argv: string[]): HostCliArgs => {
  const result: HostCliArgs = {
    command: "help",
    config: "config/default.json",
    aboxBin: "abox",
    mode: "build",
    yes: false,
    shell: "bash",
    timeoutSeconds: 120,
    maxOutputBytes: 256 * 1024,
    heartbeatIntervalMs: 5000,
    killGraceMs: 2000,
    copilot: {},
  };
  let explicitMode = false;

  let index = 0;
  if (argv[0] !== undefined && HOST_COMMANDS.has(argv[0] as HostCommand)) {
    result.command = argv[0] as HostCommand;
    if (result.command === "build" || result.command === "plan") {
      result.mode = result.command;
    }
    index = 1;
  } else if (argv.includes("--goal") || argv.some((arg) => arg.startsWith("--goal="))) {
    result.command = "run";
  } else if (
    // `-p` / `--prompt` is Copilot-parity one-shot mode: bakudo runs the
    // prompt and exits. Treat it like `run` when no explicit command preceded.
    argv.includes("-p") ||
    argv.includes("--prompt") ||
    argv.some((arg) => arg.startsWith("--prompt="))
  ) {
    result.command = "run";
  } else if (argv.length > 0 && !argv[0]?.startsWith("--")) {
    result.command = "run";
  }

  const positionals: string[] = [];
  for (let i = index; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) {
      continue;
    }
    if (arg === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (arg === "--help" || arg === "-h") {
      result.command = "help";
      continue;
    }
    if (arg === "--goal" || arg.startsWith("--goal=")) {
      const { value, consumed } = readLongFlag(argv, i, "--goal");
      result.goal = value;
      i += consumed - 1;
      continue;
    }
    if (arg === "--config" || arg.startsWith("--config=")) {
      const { value, consumed } = readLongFlag(argv, i, "--config");
      result.config = value;
      i += consumed - 1;
      continue;
    }
    if (arg === "--abox-bin" || arg.startsWith("--abox-bin=")) {
      const { value, consumed } = readLongFlag(argv, i, "--abox-bin");
      result.aboxBin = value;
      i += consumed - 1;
      continue;
    }
    if (arg === "--repo" || arg.startsWith("--repo=")) {
      const { value, consumed } = readLongFlag(argv, i, "--repo");
      result.repo = value;
      i += consumed - 1;
      continue;
    }
    if (arg === "--mode" || arg.startsWith("--mode=")) {
      const { value, consumed } = readLongFlag(argv, i, "--mode");
      if (value !== "build" && value !== "plan") {
        throw new Error("invalid --mode: expected build or plan");
      }
      result.mode = value;
      explicitMode = true;
      i += consumed - 1;
      continue;
    }
    if (arg === "--yes" || arg === "-y") {
      result.yes = true;
      continue;
    }
    if (arg === "--storage-root" || arg.startsWith("--storage-root=")) {
      const { value, consumed } = readLongFlag(argv, i, "--storage-root");
      result.storageRoot = value;
      i += consumed - 1;
      continue;
    }
    if (arg === "--shell" || arg.startsWith("--shell=")) {
      const { value, consumed } = readLongFlag(argv, i, "--shell");
      result.shell = value;
      i += consumed - 1;
      continue;
    }
    if (arg === "--session-id" || arg.startsWith("--session-id=")) {
      const { value, consumed } = readLongFlag(argv, i, "--session-id");
      result.sessionId = value;
      i += consumed - 1;
      continue;
    }
    if (arg === "--task-id" || arg.startsWith("--task-id=")) {
      const { value, consumed } = readLongFlag(argv, i, "--task-id");
      result.taskId = value;
      i += consumed - 1;
      continue;
    }
    if (arg === "--timeout-seconds" || arg.startsWith("--timeout-seconds=")) {
      const { value, consumed } = readLongFlag(argv, i, "--timeout-seconds");
      result.timeoutSeconds = parsePositiveInteger(
        value,
        "--timeout-seconds",
        result.timeoutSeconds,
      );
      i += consumed - 1;
      continue;
    }
    if (arg === "--max-output-bytes" || arg.startsWith("--max-output-bytes=")) {
      const { value, consumed } = readLongFlag(argv, i, "--max-output-bytes");
      result.maxOutputBytes = parsePositiveInteger(
        value,
        "--max-output-bytes",
        result.maxOutputBytes,
      );
      i += consumed - 1;
      continue;
    }
    if (arg === "--heartbeat-ms" || arg.startsWith("--heartbeat-ms=")) {
      const { value, consumed } = readLongFlag(argv, i, "--heartbeat-ms");
      result.heartbeatIntervalMs = parsePositiveInteger(
        value,
        "--heartbeat-ms",
        result.heartbeatIntervalMs,
      );
      i += consumed - 1;
      continue;
    }
    if (arg === "--kill-grace-ms" || arg.startsWith("--kill-grace-ms=")) {
      const { value, consumed } = readLongFlag(argv, i, "--kill-grace-ms");
      result.killGraceMs = parsePositiveInteger(value, "--kill-grace-ms", result.killGraceMs);
      i += consumed - 1;
      continue;
    }

    // Copilot-parity namespace (Phase 5 PR11). Delegated to keep this file
    // under the 400-line cap.
    const copilotConsumed = tryConsumeCopilotFlag(argv, i, result.copilot);
    if (copilotConsumed.consumed > 0) {
      i += copilotConsumed.consumed - 1;
      continue;
    }

    if (arg.startsWith("--")) {
      throw new Error(`unknown option: ${arg}`);
    }

    positionals.push(arg);
  }

  if (RUN_COMMANDS.has(result.command)) {
    if (
      (result.command === "build" || result.command === "plan") &&
      explicitMode &&
      result.mode !== result.command
    ) {
      throw new Error(`command ${result.command} cannot be combined with --mode ${result.mode}`);
    }
    if (result.command === "build" || result.command === "plan") {
      result.mode = result.command;
    }
    const positionalGoal = positionals.join(" ").trim();
    const resolvedGoal =
      result.goal ?? (positionalGoal.length > 0 ? positionalGoal : (result.copilot.prompt ?? ""));
    if (!resolvedGoal) {
      throw new Error(`missing goal for ${result.command}`);
    }
    result.goal = resolvedGoal;
  } else if (SESSION_REQUIRED_COMMANDS.has(result.command)) {
    const sessionId = result.sessionId ?? positionals[0];
    const taskId = result.taskId ?? positionals[1];
    if (!sessionId) {
      throw new Error(`missing session id for ${result.command}`);
    }
    result.sessionId = sessionId;
    if (taskId !== undefined) {
      result.taskId = taskId;
    }
  } else if (result.command === "status") {
    if (positionals.length > 1) {
      throw new Error("status accepts at most one session id");
    }
    if (positionals[0] !== undefined) {
      result.sessionId = positionals[0];
    }
  } else if (result.command === "review") {
    const sessionId = result.sessionId ?? positionals[0];
    const taskId = result.taskId ?? positionals[1];
    if (!sessionId) {
      throw new Error("missing session id for review");
    }
    result.sessionId = sessionId;
    if (taskId !== undefined) {
      result.taskId = taskId;
    }
  } else if (result.command === "sessions") {
    if (positionals.length > 0) {
      throw new Error("sessions does not accept positional arguments");
    }
  } else if (result.command === "init") {
    if (positionals.length > 0) {
      throw new Error("init does not accept positional arguments");
    }
  }

  return result;
};

export const shouldUseHostCli = (argv: string[]): boolean => {
  if (argv.length === 0) {
    return true;
  }

  const first = argv[0];
  return (
    first === undefined ||
    first === "--help" ||
    first === "-h" ||
    HOST_COMMANDS.has(first as HostCommand) ||
    (!first.startsWith("--") && !first.includes("=")) ||
    argv.includes("--session-id") ||
    argv.includes("--task-id") ||
    argv.includes("-p") ||
    argv.includes("--prompt") ||
    argv.some((arg) => arg.startsWith("--prompt="))
  );
};

export const tokenizeCommand = (input: string): string[] =>
  input.trim().split(/\s+/).filter(Boolean);
