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
 * Copilot-parity flag namespace (2026-04-14 reference additions). PR4 only
 * wires the parsers so the flags are recognized without erroring. Full
 * semantics land in Phase 5 (prompt plumbing, streaming toggles, JSON output,
 * permission policy, non-interactive automation).
 */
export type CopilotParityFlags = {
  /** `-p`, `--prompt` — alternate source for the goal prompt. Reserved. */
  prompt?: string;
  /** `--stream=off` — disable live streaming in favor of buffered output. */
  streamOff?: boolean;
  /** `--plain-diff` — emit diffs in plain text rather than ansi. */
  plainDiff?: boolean;
  /** `--output-format=json` — machine-readable summary output. */
  outputFormat?: "json" | "text";
  /** `--allow-all-tools` — Phase 5 permission bypass (autopilot CI mode). */
  allowAllTools?: boolean;
  /** `--no-ask-user` — fail instead of prompting when user input is needed. */
  noAskUser?: boolean;
};

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

    // Copilot-parity namespace — recognized but not yet consumed. Phase 5.
    if (arg === "-p" || arg === "--prompt" || arg.startsWith("--prompt=")) {
      const flag = arg === "-p" ? "-p" : "--prompt";
      if (flag === "-p") {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith("--")) {
          throw new Error(`missing value for ${flag}`);
        }
        result.copilot.prompt = next;
        i += 1;
      } else {
        const { value, consumed } = readLongFlag(argv, i, "--prompt");
        result.copilot.prompt = value;
        i += consumed - 1;
      }
      continue;
    }
    if (arg === "--stream" || arg.startsWith("--stream=")) {
      const { value, consumed } = readLongFlag(argv, i, "--stream");
      if (value !== "on" && value !== "off") {
        throw new Error("invalid --stream: expected on or off");
      }
      result.copilot.streamOff = value === "off";
      i += consumed - 1;
      continue;
    }
    if (arg === "--plain-diff") {
      result.copilot.plainDiff = true;
      continue;
    }
    if (arg === "--output-format" || arg.startsWith("--output-format=")) {
      const { value, consumed } = readLongFlag(argv, i, "--output-format");
      if (value !== "json" && value !== "text") {
        throw new Error("invalid --output-format: expected json or text");
      }
      result.copilot.outputFormat = value;
      i += consumed - 1;
      continue;
    }
    if (arg === "--allow-all-tools") {
      result.copilot.allowAllTools = true;
      continue;
    }
    if (arg === "--no-ask-user") {
      result.copilot.noAskUser = true;
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
    argv.includes("--task-id")
  );
};

export const tokenizeCommand = (input: string): string[] =>
  input.trim().split(/\s+/).filter(Boolean);
