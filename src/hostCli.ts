#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { mkdir, writeFile, access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";

import { ABoxAdapter } from "./aboxAdapter.js";
import { ABoxTaskRunner } from "./aboxTaskRunner.js";
import { ArtifactStore } from "./artifactStore.js";
import { buildRuntimeConfig, loadConfig } from "./config.js";
import { isMainModule } from "./mainModule.js";
import { BAKUDO_PROTOCOL_SCHEMA_VERSION, type TaskMode, type TaskRequest } from "./protocol.js";
import { type ReviewedTaskResult, reviewTaskResult } from "./reviewer.js";
import { SessionStore, sanitizePathSegment } from "./sessionStore.js";
import type { SessionRecord, SessionStatus, SessionTaskRecord } from "./sessionTypes.js";
import { createSessionTaskKey } from "./sessionTypes.js";
import type { WorkerTaskSpec } from "./workerRuntime.js";

type HostCommand =
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

type HostIo = {
  stdin?: Readable;
  stdout?: Writable;
  stderr?: Writable;
};

type TextWriter = {
  write(data: string | Uint8Array): unknown;
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
};

const HOST_COMMANDS = new Set<HostCommand>([
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

const RUN_COMMANDS = new Set<HostCommand>(["run", "build", "plan"]);
const SESSION_REQUIRED_COMMANDS = new Set<HostCommand>([
  "resume",
  "tasks",
  "review",
  "logs",
  "sandbox",
]);

type SlashCommandSpec = {
  usage: string;
  description: string;
};

const INTERACTIVE_COMMANDS: readonly SlashCommandSpec[] = [
  { usage: "/build <goal>", description: "Run a code-changing task in an abox sandbox." },
  {
    usage: "/plan <goal>",
    description: "Run a planning or discovery task in a safer host intent mode.",
  },
  { usage: "/run <goal>", description: "Run a task using the current shell mode." },
  { usage: "/clear", description: "Clear the terminal and redraw the shell header." },
  { usage: "/mode <build|plan>", description: "Change the default mode for plain-text prompts." },
  {
    usage: "/approve <auto|prompt>",
    description: "Toggle automatic approval for build dispatches.",
  },
  {
    usage: "/status [session]",
    description: "Show all sessions or task status for a specific session.",
  },
  { usage: "/sessions", description: "List saved sessions." },
  { usage: "/tasks <session>", description: "List tasks for a session." },
  { usage: "/sandbox <session> [task]", description: "Show abox dispatch metadata and artifacts." },
  {
    usage: "/review <session> [task]",
    description: "Show the host-reviewed outcome and suggested next action.",
  },
  { usage: "/logs <session> [task]", description: "Print the structured worker event stream." },
  {
    usage: "/resume <session> [task]",
    description: "Retry the latest resumable task in a session.",
  },
  { usage: "/init", description: "Write a repo-local AGENTS.md template for bakudo." },
  { usage: "/help", description: "Show command help." },
  { usage: "/exit", description: "Exit the interactive shell." },
] as const;
const runtimeIo = process as unknown as HostIo;
const runtimeProcess = (
  globalThis as unknown as {
    process?: {
      stdout?: { isTTY?: boolean; columns?: number };
      env?: Record<string, string | undefined>;
    };
  }
).process;

const ANSI = {
  reset: "\u001B[0m",
  bold: "\u001B[1m",
  dim: "\u001B[2m",
  blue: "\u001B[34m",
  cyan: "\u001B[36m",
  green: "\u001B[32m",
  yellow: "\u001B[33m",
  red: "\u001B[31m",
  magenta: "\u001B[35m",
  gray: "\u001B[90m",
} as const;

const supportsAnsi = (): boolean =>
  runtimeProcess?.stdout?.isTTY === true && runtimeProcess?.env?.NO_COLOR === undefined;

const paint = (text: string, ...codes: string[]): string =>
  supportsAnsi() ? `${codes.join("")}${text}${ANSI.reset}` : text;

const bold = (text: string): string => paint(text, ANSI.bold);
const dim = (text: string): string => paint(text, ANSI.dim);
const cyan = (text: string): string => paint(text, ANSI.cyan);
const blue = (text: string): string => paint(text, ANSI.blue);
const green = (text: string): string => paint(text, ANSI.green);
const yellow = (text: string): string => paint(text, ANSI.yellow);
const red = (text: string): string => paint(text, ANSI.red);
const gray = (text: string): string => paint(text, ANSI.gray);

const renderTitle = (title: string, subtitle?: string): string[] => [
  bold(blue(title)),
  ...(subtitle ? [dim(subtitle)] : []),
];

const renderSection = (title: string): string => bold(cyan(title));

const renderKeyValue = (label: string, value: string): string => `${dim(label.padEnd(8))} ${value}`;

const renderCommandHint = (command: string, description: string): string =>
  `${paint(command.padEnd(28), ANSI.bold, ANSI.magenta)} ${dim(description)}`;

const renderModeChip = (mode: TaskMode): string =>
  mode === "build" ? paint("BUILD", ANSI.bold, ANSI.yellow) : paint("PLAN", ANSI.bold, ANSI.cyan);

const renderApprovalChip = (autoApprove: boolean): string =>
  autoApprove ? paint("AUTO", ANSI.bold, ANSI.green) : paint("PROMPT", ANSI.bold, ANSI.magenta);

const overviewPanelLines = (): string[] => [
  dim("Enter a goal to run with the current mode."),
  dim("Use /status to inspect sessions, /review for the host verdict, /exit to leave."),
];

const ANSI_PATTERN = /\u001B\[[0-9;]*m/g;

const stripAnsi = (value: string): string => value.replace(ANSI_PATTERN, "");

const displayWidth = (value: string): number => stripAnsi(value).length;

const fitDisplay = (value: string, width: number): string => {
  if (width <= 0) {
    return "";
  }
  const plain = stripAnsi(value);
  if (plain.length <= width) {
    return `${value}${" ".repeat(width - plain.length)}`;
  }
  if (width <= 3) {
    return plain.slice(0, width);
  }
  return `${plain.slice(0, width - 3)}...`;
};

const wrapPlain = (value: string, width: number): string[] => {
  const plain = stripAnsi(value);
  if (width <= 0) {
    return [plain];
  }
  const wrapped: string[] = [];
  let remaining = plain;
  while (remaining.length > width) {
    wrapped.push(remaining.slice(0, width));
    remaining = remaining.slice(width);
  }
  wrapped.push(remaining);
  return wrapped;
};

const renderBox = (title: string, lines: string[], width: number, height?: number): string[] => {
  const innerWidth = Math.max(8, width - 4);
  const top = `+${"-".repeat(Math.max(0, width - 2))}+`;
  const heading = `| ${fitDisplay(title, innerWidth)} |`;
  const content = lines.flatMap((line) =>
    wrapPlain(line, innerWidth).map((part) => `| ${fitDisplay(part, innerWidth)} |`),
  );
  const targetHeight = height === undefined ? content.length : Math.max(content.length, height);
  const padded = [...content];
  while (padded.length < targetHeight) {
    padded.push(`| ${" ".repeat(innerWidth)} |`);
  }
  return [top, heading, top, ...padded, top];
};

const mergeColumns = (left: string[], right: string[], gap = "  "): string[] => {
  const height = Math.max(left.length, right.length);
  const leftWidth = Math.max(...left.map((line) => displayWidth(line)), 0);
  const rows: string[] = [];
  for (let index = 0; index < height; index += 1) {
    const leftLine = left[index] ?? " ".repeat(leftWidth);
    const rightLine = right[index] ?? "";
    rows.push(`${fitDisplay(leftLine, leftWidth)}${gap}${rightLine}`);
  }
  return rows;
};

let activeStdoutWriter: TextWriter | undefined;

const baseStdout = (): TextWriter =>
  (runtimeIo.stdout as TextWriter | undefined) ?? (process.stdout as TextWriter);
const stdoutWrite = (text: string): void => {
  void (activeStdoutWriter ?? baseStdout()).write(text);
};
const stderrWrite = (text: string): void => {
  void (runtimeIo.stderr ?? process.stderr).write(text);
};

const withCapturedStdout = async <T>(writer: TextWriter, fn: () => Promise<T>): Promise<T> => {
  const prior = activeStdoutWriter;
  activeStdoutWriter = writer;
  try {
    return await fn();
  } finally {
    activeStdoutWriter = prior;
  }
};

const parsePositiveInteger = (
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

const readLongFlag = (
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
    result.goal = result.goal ?? positionals.join(" ").trim();
    if (!result.goal) {
      throw new Error(`missing goal for ${result.command}`);
    }
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

const buildUsageLines = (): string[] => {
  const interactiveLines = INTERACTIVE_COMMANDS.map((command) =>
    renderCommandHint(command.usage, command.description),
  );
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

const printUsage = (): void => {
  const lines = buildUsageLines();
  stdoutWrite(lines.join("\n") + "\n");
};

const storageRootFor = (repo: string | undefined, explicitRoot: string | undefined): string =>
  explicitRoot !== undefined ? resolve(explicitRoot) : resolve(repo ?? ".", ".bakudo", "sessions");

const repoRootFor = (repo: string | undefined): string => resolve(repo ?? ".");

const buildAgentsTemplate = (repoRoot: string): string =>
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

const sessionStatusFromReview = (reviewed: ReviewedTaskResult): SessionStatus => {
  if (reviewed.outcome === "success") {
    return "completed";
  }
  if (reviewed.outcome === "blocked_needs_user") {
    return "awaiting_user";
  }
  if (reviewed.outcome === "policy_denied") {
    return "blocked";
  }
  if (reviewed.outcome === "incomplete_needs_follow_up") {
    return "reviewing";
  }
  return "failed";
};

export const reviewedOutcomeExitCode = (reviewed: ReviewedTaskResult): number => {
  if (reviewed.outcome === "success") {
    return 0;
  }
  if (reviewed.outcome === "blocked_needs_user") {
    return 2;
  }
  if (reviewed.outcome === "policy_denied") {
    return 3;
  }
  return 1;
};

const requiresSandboxApproval = (args: HostCliArgs): boolean => args.mode === "build";

const promptForApproval = async (message: string): Promise<boolean> => {
  const input = runtimeIo.stdin;
  const output = runtimeIo.stdout;
  if (!input || !output) {
    return false;
  }

  const rl = createInterface({ input, output });
  try {
    const prompt = `${renderSection("Approval")} ${message} ${dim("[y/N]")} `;
    const answer = (await rl.question(prompt)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
};

const createTaskSpec = (
  sessionId: string,
  taskId: string,
  goal: string,
  assumeDangerousSkipPermissions: boolean,
  args: HostCliArgs,
): WorkerTaskSpec => ({
  schemaVersion: BAKUDO_PROTOCOL_SCHEMA_VERSION,
  taskId,
  sessionId,
  goal,
  mode: args.mode,
  cwd: ".",
  timeoutSeconds: args.timeoutSeconds,
  maxOutputBytes: args.maxOutputBytes,
  heartbeatIntervalMs: args.heartbeatIntervalMs,
  assumeDangerousSkipPermissions,
});

const recordTask = (
  request: TaskRequest,
  status: SessionTaskRecord["status"],
  lastMessage?: string,
): SessionTaskRecord => ({
  taskId: request.taskId,
  request,
  status,
  ...(lastMessage === undefined ? {} : { lastMessage }),
});

const writeSessionArtifact = async (
  artifactStore: ArtifactStore,
  sessionId: string,
  taskId: string,
  name: string,
  contents: string,
  kind: string,
  metadata?: Record<string, unknown>,
): Promise<void> => {
  const artifactsDir = artifactStore.artifactDir(sessionId);
  await mkdir(artifactsDir, { recursive: true });
  const safeName = `${sanitizePathSegment(taskId)}-${name}`;
  const filePath = join(artifactsDir, safeName);
  await writeFile(filePath, contents, "utf8");
  await artifactStore.registerArtifact({
    artifactId: `${taskId}:${name}`,
    sessionId,
    taskId,
    kind,
    name,
    path: filePath,
    ...(metadata === undefined ? {} : { metadata }),
  });
};

const printRunSummary = (session: SessionRecord, reviewed: ReviewedTaskResult): void => {
  const task = session.tasks.find((entry) => entry.taskId === reviewed.taskId);
  const sandboxTaskId =
    typeof task?.metadata?.sandboxTaskId === "string" ? task.metadata.sandboxTaskId : "n/a";
  stdoutWrite(
    [
      "",
      renderSection("Summary"),
      renderKeyValue("Session", session.sessionId),
      renderKeyValue("Status", `${statusBadge(session.status)} ${session.status}`),
      renderKeyValue("Task", reviewed.taskId),
      renderKeyValue("Sandbox", sandboxTaskId),
      renderKeyValue("Outcome", `${statusBadge(reviewed.outcome)} ${reviewed.outcome}`),
      renderKeyValue("Action", reviewed.action),
      renderKeyValue("Reason", reviewed.reason),
      renderKeyValue("Summary", reviewed.result.summary),
    ].join("\n") + "\n",
  );
};

const statusBadge = (status: string): string => {
  switch (status) {
    case "completed":
    case "succeeded":
    case "success":
      return green("[OK]");
    case "running":
    case "reviewing":
      return blue("[RUN]");
    case "planned":
    case "queued":
      return cyan("[QUE]");
    case "awaiting_user":
    case "blocked":
    case "blocked_needs_user":
      return yellow("[ASK]");
    case "failed":
    case "retryable_failure":
    case "policy_denied":
      return red("[ERR]");
    default:
      return gray("[---]");
  }
};

const formatUtcTimestamp = (value: string | undefined): string => {
  if (!value) {
    return "n/a";
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toISOString().replace("T", " ").replace(".000Z", "Z");
};

const nextActionHint = (reviewed: ReviewedTaskResult): string => {
  switch (reviewed.action) {
    case "accept":
      return "No follow-up needed.";
    case "retry":
      return "Use `bakudo resume <session-id> [task-id]` to retry with the current host settings.";
    case "ask_user":
      return "Inspect `bakudo review` and `bakudo sandbox` before deciding whether to retry or adjust scope.";
    case "follow_up":
      return "Review worker logs and artifacts, then decide whether the host should retry or narrow the task.";
    case "halt":
      return "Stop here until the host policy or task framing changes.";
    default:
      return "Inspect the session before taking the next step.";
  }
};

const formatArtifacts = (
  artifacts: Awaited<ReturnType<ArtifactStore["listTaskArtifacts"]>>,
): string[] =>
  artifacts.map((artifact) => `  - ${artifact.name} (${artifact.kind}) -> ${artifact.path}`);

const taskModeLabel = (task: SessionTaskRecord): string =>
  task.request?.mode ?? (task.request?.assumeDangerousSkipPermissions ? "build" : "plan");

const latestTaskRecord = (
  session: SessionRecord,
  taskId?: string,
): SessionTaskRecord | undefined => {
  if (taskId !== undefined) {
    return session.tasks.find((task) => task.taskId === taskId);
  }
  return session.tasks.at(-1);
};

const executeTask = async (
  sessionStore: SessionStore,
  artifactStore: ArtifactStore,
  runner: ABoxTaskRunner,
  sessionId: string,
  request: WorkerTaskSpec,
  args: HostCliArgs,
): Promise<ReviewedTaskResult> => {
  await sessionStore.upsertTask(
    sessionId,
    recordTask(request, "queued", "queued for sandbox execution"),
  );
  stdoutWrite(
    [
      "",
      renderSection("Dispatch"),
      `${statusBadge("queued")} ${renderModeChip(request.mode ?? args.mode)} ${dim("sending task to abox worker")}`,
      renderKeyValue("Session", sessionId),
      renderKeyValue("Task", request.taskId),
      renderKeyValue("Goal", request.goal),
      renderKeyValue("Sandbox", "ephemeral abox worker"),
      "",
    ].join("\n"),
  );
  const execution = await runner.runTask(
    request,
    {
      shell: args.shell,
      timeoutSeconds: args.timeoutSeconds,
      maxOutputBytes: args.maxOutputBytes,
      heartbeatIntervalMs: args.heartbeatIntervalMs,
      killGraceMs: args.killGraceMs,
    },
    {
      onEvent: (event) => {
        const stamp = event.timestamp.slice(11, 19);
        const metrics = [
          event.elapsedMs !== undefined ? `elapsed=${event.elapsedMs}ms` : "",
          event.stdoutBytes !== undefined ? `stdout=${event.stdoutBytes}B` : "",
          event.stderrBytes !== undefined ? `stderr=${event.stderrBytes}B` : "",
          event.exitCode !== undefined && event.exitCode !== null ? `exit=${event.exitCode}` : "",
          event.timedOut ? "timed_out=true" : "",
        ]
          .filter(Boolean)
          .join(" ");
        const detail = event.message ? ` ${event.message}` : "";
        stdoutWrite(
          `${dim(`[${stamp}]`)} ${statusBadge(event.status)} ${bold(event.kind)}${detail}${metrics ? ` ${dim(`(${metrics})`)}` : ""}\n`,
        );
      },
      onWorkerError: (error) => {
        const message = typeof error.message === "string" ? error.message : JSON.stringify(error);
        stdoutWrite(`[worker-error] ${message}\n`);
      },
    },
  );

  for (const event of execution.events) {
    await sessionStore.appendTaskEvent(sessionId, event);
  }

  const reviewed = reviewTaskResult(execution.result);
  await sessionStore.upsertTask(sessionId, {
    taskId: request.taskId,
    request,
    status: execution.result.status,
    result: execution.result,
    lastMessage: reviewed.reason,
    metadata: {
      sandboxTaskId: execution.metadata?.taskId,
      aboxCommand: execution.metadata?.cmd,
      reviewedOutcome: reviewed.outcome,
      reviewedAction: reviewed.action,
    },
  });

  await writeSessionArtifact(
    artifactStore,
    sessionId,
    request.taskId,
    "result.json",
    `${JSON.stringify(execution.result, null, 2)}\n`,
    "result",
    { outcome: reviewed.outcome },
  );
  await writeSessionArtifact(
    artifactStore,
    sessionId,
    request.taskId,
    "worker-output.log",
    `${execution.rawOutput}\n`,
    "log",
    { ok: execution.ok, errorCount: execution.workerErrors.length },
  );
  await writeSessionArtifact(
    artifactStore,
    sessionId,
    request.taskId,
    "dispatch.json",
    `${JSON.stringify(
      {
        sandboxTaskId: execution.metadata?.taskId,
        aboxCommand: execution.metadata?.cmd,
        reviewedOutcome: reviewed.outcome,
        reviewedAction: reviewed.action,
      },
      null,
      2,
    )}\n`,
    "dispatch",
  );

  return reviewed;
};

const runNewSession = async (args: HostCliArgs): Promise<number> => {
  const fileConfig = await loadConfig(args.config);
  const runtimeConfig = buildRuntimeConfig(fileConfig);
  const rootDir = storageRootFor(args.repo, args.storageRoot);
  const sessionId = args.sessionId ?? `session-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const assumeDangerousSkipPermissions =
    args.mode === "build" ? runtimeConfig.assumeDangerousSkipPermissions : false;
  const sessionStore = new SessionStore(rootDir);
  const artifactStore = new ArtifactStore(rootDir);
  const runner = new ABoxTaskRunner(new ABoxAdapter(args.aboxBin, args.repo));

  if (requiresSandboxApproval(args) && !args.yes) {
    const approved = await promptForApproval(
      `Dispatch a ${args.mode} task into an ephemeral abox sandbox with dangerous-skip-permissions?`,
    );
    if (!approved) {
      stdoutWrite("Dispatch cancelled.\n");
      return 2;
    }
  }

  const session = await sessionStore.createSession({
    sessionId,
    goal: args.goal ?? "",
    assumeDangerousSkipPermissions,
    status: "planned",
  });

  const taskId = createSessionTaskKey(session.sessionId, "task-1");
  const request = createTaskSpec(
    session.sessionId,
    taskId,
    args.goal ?? "",
    assumeDangerousSkipPermissions,
    args,
  );
  await sessionStore.saveSession({ ...session, status: "running" });
  const reviewed = await executeTask(
    sessionStore,
    artifactStore,
    runner,
    session.sessionId,
    request,
    args,
  );

  const finalSession = await sessionStore.saveSession({
    ...(await sessionStore.loadSession(session.sessionId))!,
    status: sessionStatusFromReview(reviewed),
  });
  printRunSummary(finalSession, reviewed);
  return reviewedOutcomeExitCode(reviewed);
};

const resumeSession = async (args: HostCliArgs): Promise<number> => {
  const rootDir = storageRootFor(args.repo, args.storageRoot);
  const sessionStore = new SessionStore(rootDir);
  const artifactStore = new ArtifactStore(rootDir);
  const session = await sessionStore.loadSession(args.sessionId ?? "");
  if (session === null) {
    throw new Error(`unknown session: ${args.sessionId}`);
  }

  const task = latestTaskRecord(session, args.taskId);
  if (task === undefined || task.request === undefined) {
    throw new Error(`no resumable task found for session ${session.sessionId}`);
  }

  const priorReview = task.result === undefined ? null : reviewTaskResult(task.result);
  if (priorReview?.outcome === "success") {
    printRunSummary(session, priorReview);
    return 0;
  }
  if (priorReview?.outcome === "blocked_needs_user" || priorReview?.outcome === "policy_denied") {
    printRunSummary(session, priorReview);
    return reviewedOutcomeExitCode(priorReview);
  }

  if (requiresSandboxApproval(args) && !args.yes) {
    const approved = await promptForApproval(
      `Re-dispatch task ${task.taskId} into an ephemeral abox sandbox with dangerous-skip-permissions?`,
    );
    if (!approved) {
      stdoutWrite("Resume cancelled.\n");
      return 2;
    }
  }

  const runner = new ABoxTaskRunner(new ABoxAdapter(args.aboxBin, args.repo));
  const retryId = createSessionTaskKey(session.sessionId, `retry-${session.tasks.length + 1}`);
  const request: WorkerTaskSpec = {
    ...task.request,
    taskId: retryId,
    timeoutSeconds: args.timeoutSeconds,
    maxOutputBytes: args.maxOutputBytes,
    heartbeatIntervalMs: args.heartbeatIntervalMs,
  };

  await sessionStore.saveSession({ ...session, status: "running" });
  const reviewed = await executeTask(
    sessionStore,
    artifactStore,
    runner,
    session.sessionId,
    request,
    args,
  );
  const updated = await sessionStore.saveSession({
    ...(await sessionStore.loadSession(session.sessionId))!,
    status: sessionStatusFromReview(reviewed),
  });
  printRunSummary(updated, reviewed);
  return reviewedOutcomeExitCode(reviewed);
};

const printTasks = async (args: HostCliArgs): Promise<number> => {
  const rootDir = storageRootFor(args.repo, args.storageRoot);
  const session = await new SessionStore(rootDir).loadSession(args.sessionId ?? "");
  if (session === null) {
    throw new Error(`unknown session: ${args.sessionId}`);
  }

  const lines = [
    renderSection("Tasks"),
    renderKeyValue("Session", session.sessionId),
    renderKeyValue("Status", `${statusBadge(session.status)} ${session.status}`),
    renderKeyValue("Goal", session.goal),
    "",
  ];
  for (const task of session.tasks) {
    const reviewed = task.result === undefined ? null : reviewTaskResult(task.result);
    const sandboxTaskId =
      typeof task.metadata?.sandboxTaskId === "string" ? task.metadata.sandboxTaskId : "n/a";
    lines.push(
      `- ${statusBadge(task.status)} ${task.taskId} mode=${taskModeLabel(task)} status=${task.status} sandbox=${sandboxTaskId}${reviewed ? ` outcome=${reviewed.outcome} action=${reviewed.action}` : ""}${task.lastMessage ? ` message=${task.lastMessage}` : ""}`,
    );
  }
  stdoutWrite(lines.join("\n") + "\n");
  return 0;
};

const printSessions = async (args: HostCliArgs): Promise<number> => {
  const rootDir = storageRootFor(args.repo, args.storageRoot);
  const sessions = await new SessionStore(rootDir).listSessions();
  if (sessions.length === 0) {
    stdoutWrite(
      [
        renderSection("Sessions"),
        "  No sessions found yet.",
        dim('  Try `bakudo plan "inspect the repo"` or start the shell with `bakudo`.'),
      ].join("\n") + "\n",
    );
    return 0;
  }

  const lines = [renderSection("Sessions")];
  for (const session of sessions) {
    const latestTask = session.tasks.at(-1);
    const reviewed = latestTask?.result ? reviewTaskResult(latestTask.result) : null;
    lines.push(
      `- ${statusBadge(session.status)} ${session.sessionId} status=${session.status} tasks=${session.tasks.length} updated=${session.updatedAt}${reviewed ? ` latest=${reviewed.outcome}` : ""} goal=${session.goal}`,
    );
  }
  stdoutWrite(lines.join("\n") + "\n");
  return 0;
};

const printStatus = async (args: HostCliArgs): Promise<number> => {
  if (!args.sessionId) {
    stdoutWrite(`${renderSection("Host Status")}\n`);
    return printSessions(args);
  }

  const rootDir = storageRootFor(args.repo, args.storageRoot);
  const session = await new SessionStore(rootDir).loadSession(args.sessionId);
  if (session === null) {
    throw new Error(`unknown session: ${args.sessionId}`);
  }

  const latestTask = session.tasks.at(-1);
  const reviewed = latestTask?.result ? reviewTaskResult(latestTask.result) : null;
  const lines = [
    renderSection("Status"),
    renderKeyValue("Session", session.sessionId),
    renderKeyValue("Goal", session.goal),
    renderKeyValue("State", `${statusBadge(session.status)} ${session.status}`),
    renderKeyValue("Updated", formatUtcTimestamp(session.updatedAt)),
    renderKeyValue("Tasks", String(session.tasks.length)),
  ];
  if (latestTask) {
    const sandboxTaskId =
      typeof latestTask.metadata?.sandboxTaskId === "string"
        ? latestTask.metadata.sandboxTaskId
        : "n/a";
    lines.push(
      renderKeyValue(
        "Latest",
        `${latestTask.taskId} mode=${taskModeLabel(latestTask)} status=${latestTask.status}`,
      ),
    );
    lines.push(renderKeyValue("Sandbox", sandboxTaskId));
    if (reviewed) {
      lines.push(renderKeyValue("Outcome", `${statusBadge(reviewed.outcome)} ${reviewed.outcome}`));
      lines.push(renderKeyValue("Action", reviewed.action));
      lines.push(renderKeyValue("Next", nextActionHint(reviewed)));
    }
  }
  stdoutWrite(lines.join("\n") + "\n");
  return 0;
};

const runInit = async (args: HostCliArgs): Promise<number> => {
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

const printSandbox = async (args: HostCliArgs): Promise<number> => {
  const rootDir = storageRootFor(args.repo, args.storageRoot);
  const session = await new SessionStore(rootDir).loadSession(args.sessionId ?? "");
  if (session === null) {
    throw new Error(`unknown session: ${args.sessionId}`);
  }

  const task = latestTaskRecord(session, args.taskId);
  if (task === undefined) {
    throw new Error(`no task found for session ${session.sessionId}`);
  }

  const sandboxTaskId =
    typeof task.metadata?.sandboxTaskId === "string" ? task.metadata.sandboxTaskId : "n/a";
  const aboxCommand = Array.isArray(task.metadata?.aboxCommand)
    ? (task.metadata?.aboxCommand as unknown[]).map(String).join(" ")
    : "n/a";
  const artifacts = await new ArtifactStore(rootDir).listTaskArtifacts(
    session.sessionId,
    task.taskId,
  );
  stdoutWrite(
    [
      renderSection("Sandbox"),
      renderKeyValue("Session", session.sessionId),
      renderKeyValue("Task", task.taskId),
      renderKeyValue("Mode", taskModeLabel(task)),
      renderKeyValue("Status", `${statusBadge(task.status)} ${task.status}`),
      renderKeyValue("Sandbox", sandboxTaskId),
      renderKeyValue("ABox", aboxCommand),
      renderKeyValue(
        "Safety",
        task.request?.assumeDangerousSkipPermissions
          ? "dangerous-skip-permissions enabled in sandbox worker"
          : "host requested safer planning mode",
      ),
      ...(artifacts.length > 0 ? ["Artifacts:", ...formatArtifacts(artifacts)] : []),
      ...(task.result?.summary ? [renderKeyValue("Summary", task.result.summary)] : []),
      renderKeyValue(
        "Next",
        "Use `bakudo review` for the host verdict or `bakudo logs` for the event stream.",
      ),
    ].join("\n") + "\n",
  );
  return 0;
};

const printReview = async (args: HostCliArgs): Promise<number> => {
  const rootDir = storageRootFor(args.repo, args.storageRoot);
  const sessionStore = new SessionStore(rootDir);
  const artifactStore = new ArtifactStore(rootDir);
  const session = await sessionStore.loadSession(args.sessionId ?? "");
  if (session === null) {
    throw new Error(`unknown session: ${args.sessionId}`);
  }

  const task = latestTaskRecord(session, args.taskId);
  if (task?.result === undefined) {
    throw new Error(`no reviewed result found for session ${session.sessionId}`);
  }

  const reviewed = reviewTaskResult(task.result);
  const artifacts = await artifactStore.listTaskArtifacts(session.sessionId, task.taskId);
  const dispatchArtifact = artifacts.find((artifact) => artifact.kind === "dispatch");
  const workerLog = artifacts.find((artifact) => artifact.kind === "log");
  stdoutWrite(
    [
      renderSection("Review"),
      renderKeyValue("Session", session.sessionId),
      renderKeyValue("Task", task.taskId),
      renderKeyValue("Status", `${statusBadge(task.status)} ${task.status}`),
      renderKeyValue("Outcome", `${statusBadge(reviewed.outcome)} ${reviewed.outcome}`),
      renderKeyValue("Action", reviewed.action),
      renderKeyValue("Reason", reviewed.reason),
      renderKeyValue("Summary", task.result.summary),
      ...(typeof task.metadata?.sandboxTaskId === "string"
        ? [renderKeyValue("Sandbox", task.metadata.sandboxTaskId)]
        : []),
      ...(task.result.exitCode === undefined
        ? []
        : [renderKeyValue("Exit", String(task.result.exitCode))]),
      ...(task.result.startedAt
        ? [renderKeyValue("Started", formatUtcTimestamp(task.result.startedAt))]
        : []),
      renderKeyValue("Finished", formatUtcTimestamp(task.result.finishedAt)),
      ...(dispatchArtifact ? [renderKeyValue("Dispatch", dispatchArtifact.path)] : []),
      ...(workerLog ? [renderKeyValue("Worker", workerLog.path)] : []),
      ...(artifacts.length > 0 ? ["Artifacts:", ...formatArtifacts(artifacts)] : []),
      renderKeyValue("Next", nextActionHint(reviewed)),
    ].join("\n") + "\n",
  );
  return reviewedOutcomeExitCode(reviewed);
};

const printLogs = async (args: HostCliArgs): Promise<number> => {
  const rootDir = storageRootFor(args.repo, args.storageRoot);
  const sessionStore = new SessionStore(rootDir);
  const session = await sessionStore.loadSession(args.sessionId ?? "");
  if (session === null) {
    throw new Error(`unknown session: ${args.sessionId}`);
  }

  const events = await sessionStore.readTaskEvents(session.sessionId);
  const lines = events
    .filter((event) => args.taskId === undefined || event.taskId === args.taskId)
    .map(
      (event) =>
        `${event.timestamp} ${statusBadge(event.status)} ${event.taskId} ${event.kind} ${event.status}${event.message ? ` ${event.message}` : ""}`,
    );
  if (lines.length === 0) {
    stdoutWrite("No task events found.\n");
    return 0;
  }
  stdoutWrite(`${renderSection("Logs")}\n${lines.join("\n")}\n`);
  return 0;
};

const tokenizeCommand = (input: string): string[] => input.trim().split(/\s+/).filter(Boolean);

type InteractiveShellState = {
  currentMode: TaskMode;
  autoApprove: boolean;
  lastSessionId?: string;
  lastTaskId?: string;
};

type InteractiveResolution = {
  argv: string[];
  sessionId?: string;
  taskId?: string;
};

class InteractiveDashboard {
  public constructor(private readonly getState: () => InteractiveShellState) {}

  private panelTitle = "Overview";
  private panelLines: string[] = overviewPanelLines();
  private activityLines: string[] = [];

  public setPanel(title: string, lines: string[]): void {
    this.panelTitle = title;
    this.panelLines = lines.length > 0 ? lines : [dim("No details available.")];
  }

  public appendActivity(line: string): void {
    const trimmed = line.replace(/\r/g, "").trimEnd();
    if (trimmed.length === 0) {
      return;
    }
    this.activityLines.push(trimmed);
    this.activityLines = this.activityLines.slice(-12);
  }

  public note(line: string): void {
    this.appendActivity(line);
  }

  public snapshotActivity(): string[] {
    return [...this.activityLines];
  }

  public restoreActivity(lines: string[]): void {
    this.activityLines = [...lines].slice(-12);
  }

  public render(): void {
    if (runtimeProcess?.stdout?.isTTY !== true) {
      return;
    }

    const state = this.getState();
    const focusSession = state.lastSessionId ?? "no session";
    const focusTask = state.lastTaskId ?? "no task";
    const terminalWidth = runtimeProcess?.stdout?.columns ?? 100;
    const panelContent = this.panelLines.length > 0 ? this.panelLines : [dim("No panel content.")];
    const activityContent =
      this.activityLines.length > 0 ? this.activityLines : [dim("No recent activity yet.")];
    const summaryLines = [
      `Mode: ${stripAnsi(renderModeChip(state.currentMode))}`,
      `Approval: ${stripAnsi(renderApprovalChip(state.autoApprove))}`,
      `Session: ${focusSession}`,
      `Task: ${focusTask}`,
    ];

    let body: string[];
    if (terminalWidth >= 110) {
      const leftWidth = Math.max(42, Math.floor((terminalWidth - 2) * 0.42));
      const rightWidth = Math.max(42, terminalWidth - leftWidth - 2);
      const leftBox = renderBox(this.panelTitle, [...summaryLines, "", ...panelContent], leftWidth);
      const rightBox = renderBox("Recent Activity", activityContent, rightWidth);
      body = mergeColumns(leftBox, rightBox);
    } else {
      body = [
        ...renderBox(
          this.panelTitle,
          [...summaryLines, "", ...panelContent],
          Math.max(40, terminalWidth),
        ),
        "",
        ...renderBox("Recent Activity", activityContent, Math.max(40, terminalWidth)),
      ];
    }

    const lines = [
      bold(blue("Bakudo")),
      dim("abox host control plane"),
      `${renderModeChip(state.currentMode)} ${renderApprovalChip(state.autoApprove)} ${gray(focusSession)}`,
      "",
      ...body,
      "",
      dim("Commands: /plan /build /status /review /sandbox /clear /exit"),
      "",
    ];
    void baseStdout().write("\x1Bc");
    void baseStdout().write(`${lines.join("\n")}\n`);
  }
}

const createDashboardCapture = (
  dashboard: InteractiveDashboard,
  options: { live?: boolean; recordActivity?: boolean } = {},
): { writer: TextWriter; lines: string[]; flush: () => void } => {
  const live = options.live ?? false;
  const recordActivity = options.recordActivity ?? true;
  const lines: string[] = [];
  let pending = "";
  const flush = (): void => {
    if (pending.length === 0) {
      return;
    }
    const clean = pending.replace(/\r/g, "").trimEnd();
    pending = "";
    if (clean.length === 0) {
      return;
    }
    lines.push(clean);
    if (recordActivity) {
      dashboard.appendActivity(clean);
    }
  };
  return {
    flush,
    lines,
    writer: {
      write: (chunk: string | Uint8Array) => {
        const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
        pending += text;
        const split = pending.split(/\r?\n/);
        pending = split.pop() ?? "";
        for (const line of split) {
          const clean = line.replace(/\r/g, "").trimEnd();
          if (clean.length === 0) {
            continue;
          }
          lines.push(clean);
          if (recordActivity) {
            dashboard.appendActivity(clean);
          }
        }
        if (live) {
          dashboard.render();
        }
        return true;
      },
    },
  };
};

const createInteractiveSessionIdentity = (): { sessionId: string; taskId: string } => {
  const sessionId = `session-${Date.now()}-${randomUUID().slice(0, 8)}`;
  return {
    sessionId,
    taskId: createSessionTaskKey(sessionId, "task-1"),
  };
};

const buildInteractiveRunResolution = (
  command: "run" | "build" | "plan",
  goal: string,
  state: InteractiveShellState,
): InteractiveResolution => {
  const trimmedGoal = goal.trim();
  const { sessionId, taskId } = createInteractiveSessionIdentity();
  const argv: string[] = [command];
  if (command === "run") {
    argv.push("--mode", state.currentMode);
  }
  if (state.autoApprove) {
    argv.push("--yes");
  }
  argv.push("--session-id", sessionId, trimmedGoal);
  return { argv, sessionId, taskId };
};

const resolveSessionScopedInteractiveCommand = (
  command: "status" | "tasks" | "review" | "logs" | "sandbox" | "resume",
  args: string[],
  state: InteractiveShellState,
): InteractiveResolution => {
  if (args[0]) {
    return {
      argv: [command, ...args],
      sessionId: args[0],
      ...(args[1] ? { taskId: args[1] } : {}),
    };
  }
  if (state.lastSessionId) {
    const trailingTask = state.lastTaskId ? [state.lastTaskId] : [];
    return {
      argv: [command, state.lastSessionId, ...trailingTask],
      sessionId: state.lastSessionId,
      ...(state.lastTaskId ? { taskId: state.lastTaskId } : {}),
    };
  }
  return { argv: [command, ...args] };
};

const resolveInteractiveInput = (
  line: string,
  state: InteractiveShellState,
): InteractiveResolution => {
  if (!line.startsWith("/")) {
    return buildInteractiveRunResolution("run", line, state);
  }

  const [command = "", ...args] = tokenizeCommand(line.slice(1));
  if (command === "build" || command === "plan") {
    return buildInteractiveRunResolution(command, args.join(" "), state);
  }
  if (command === "run") {
    return buildInteractiveRunResolution("run", args.join(" "), state);
  }
  if (command === "status") {
    return args[0]
      ? { argv: ["status", args[0]], sessionId: args[0] }
      : state.lastSessionId
        ? {
            argv: ["status", state.lastSessionId],
            sessionId: state.lastSessionId,
            ...(state.lastTaskId ? { taskId: state.lastTaskId } : {}),
          }
        : { argv: ["status"] };
  }
  if (
    command === "tasks" ||
    command === "review" ||
    command === "logs" ||
    command === "sandbox" ||
    command === "resume"
  ) {
    return resolveSessionScopedInteractiveCommand(command, args, state);
  }
  if (command === "sessions" || command === "help" || command === "init") {
    return { argv: [command, ...(state.autoApprove && command === "init" ? ["--yes"] : [])] };
  }

  return { argv: [command, ...args] };
};

const rememberInteractiveContext = (
  state: InteractiveShellState,
  args: HostCliArgs,
  resolution: InteractiveResolution,
): void => {
  if (resolution.sessionId) {
    state.lastSessionId = resolution.sessionId;
  } else if (args.sessionId) {
    state.lastSessionId = args.sessionId;
  }

  if (resolution.taskId) {
    state.lastTaskId = resolution.taskId;
  } else if (args.taskId) {
    state.lastTaskId = args.taskId;
  }
};

const sessionPromptLabel = (sessionId: string | undefined): string => {
  if (!sessionId) {
    return "no-session";
  }

  const parts = sessionId.split("-");
  return parts.at(-1) ?? sessionId;
};

const renderPrompt = (state: InteractiveShellState): string => {
  const session = paint(sessionPromptLabel(state.lastSessionId), ANSI.bold, ANSI.gray);
  return `${bold(blue("bakudo"))} ${renderModeChip(state.currentMode)} ${renderApprovalChip(state.autoApprove)} ${session}> `;
};

const dispatchHostCommand = async (args: HostCliArgs): Promise<number> => {
  if (args.command === "help") {
    printUsage();
    return 0;
  }
  if (args.command === "run" || args.command === "build" || args.command === "plan") {
    return runNewSession(args);
  }
  if (args.command === "sessions") {
    return printSessions(args);
  }
  if (args.command === "status") {
    return printStatus(args);
  }
  if (args.command === "sandbox") {
    return printSandbox(args);
  }
  if (args.command === "resume") {
    return resumeSession(args);
  }
  if (args.command === "tasks") {
    return printTasks(args);
  }
  if (args.command === "review") {
    return printReview(args);
  }
  if (args.command === "init") {
    return runInit(args);
  }
  return printLogs(args);
};

const runInteractiveShell = async (): Promise<number> => {
  const input = runtimeIo.stdin;
  const output = runtimeIo.stdout;
  if (!input || !output) {
    printUsage();
    return 0;
  }

  const rl = createInterface({ input, output });
  const state: InteractiveShellState = {
    currentMode: "build",
    autoApprove: false,
  };
  const dashboard = new InteractiveDashboard(() => state);
  dashboard.render();
  try {
    while (true) {
      let answer: string;
      try {
        answer = await rl.question(renderPrompt(state));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.toLowerCase().includes("readline was closed")) {
          return 0;
        }
        throw error;
      }
      const line = answer.trim();
      if (line.length === 0) {
        continue;
      }
      if (line === "/quit" || line === "/exit") {
        return 0;
      }
      if (line === "/help") {
        dashboard.setPanel("Help", buildUsageLines().slice(0, 18));
        dashboard.render();
        continue;
      }
      if (line === "/clear") {
        dashboard.setPanel("Overview", overviewPanelLines());
        dashboard.render();
        continue;
      }
      if (line.startsWith("/mode ")) {
        const nextMode = line.slice("/mode ".length).trim();
        if (nextMode !== "build" && nextMode !== "plan") {
          stderrWrite("interactive_error: mode must be build or plan\n");
          continue;
        }
        state.currentMode = nextMode;
        dashboard.setPanel("Mode", [
          renderKeyValue("Mode", `${renderModeChip(state.currentMode)} selected`),
        ]);
        dashboard.note(`Mode changed to ${state.currentMode}.`);
        dashboard.render();
        continue;
      }
      if (line.startsWith("/approve ")) {
        const policy = line.slice("/approve ".length).trim();
        if (policy !== "auto" && policy !== "prompt") {
          stderrWrite("interactive_error: approve must be auto or prompt\n");
          continue;
        }
        state.autoApprove = policy === "auto";
        dashboard.setPanel("Approval", [
          renderKeyValue("Policy", `${renderApprovalChip(state.autoApprove)} selected`),
        ]);
        dashboard.note(`Approval policy changed to ${policy}.`);
        dashboard.render();
        continue;
      }

      try {
        const resolution = resolveInteractiveInput(line, state);
        const parsed = parseHostArgs(resolution.argv);
        const activitySnapshot = dashboard.snapshotActivity();
        dashboard.note(`Command: ${line}`);
        const liveCapture =
          parsed.command === "run" ||
          parsed.command === "build" ||
          parsed.command === "plan" ||
          parsed.command === "resume";
        const recordActivity = liveCapture;
        const capture = createDashboardCapture(dashboard, { live: liveCapture, recordActivity });
        const code = await withCapturedStdout(capture.writer, async () =>
          dispatchHostCommand(parsed),
        );
        capture.flush();
        const panelTitle =
          parsed.command === "run" || parsed.command === "build" || parsed.command === "plan"
            ? "Command Result"
            : parsed.command.charAt(0).toUpperCase() + parsed.command.slice(1);
        dashboard.setPanel(panelTitle, capture.lines.slice(-18));
        if (!recordActivity) {
          dashboard.restoreActivity([...activitySnapshot, `Command: ${line}`]);
        }
        if (code !== 1) {
          rememberInteractiveContext(state, parsed, resolution);
        }
        dashboard.render();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        stderrWrite(`interactive_error: ${message}\n`);
        dashboard.note(`Error: ${message}`);
        dashboard.render();
      }
    }
  } finally {
    rl.close();
  }
};

export const runHostCli = async (argv: string[]): Promise<number> => {
  if (argv.length === 0) {
    return runInteractiveShell();
  }

  const args = parseHostArgs(argv);
  return dispatchHostCommand(args);
};

if (isMainModule(import.meta.url, process.argv[1])) {
  runHostCli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      stderrWrite(`host_cli_error: ${message}\n`);
      process.exitCode = 1;
    });
}
