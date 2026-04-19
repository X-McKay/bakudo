import { spawn } from "node:child_process";

import type { AttemptSpec } from "./attemptProtocol.js";
import {
  BAKUDO_PROTOCOL_SCHEMA_VERSION,
  type TaskProgressEvent,
  type TaskRequest,
} from "./protocol.js";
import { dispatchTaskKind } from "./worker/taskKinds.js";

export const WORKER_EVENT_PREFIX = "BAKUDO_WORKER_EVENT";
export const WORKER_RESULT_PREFIX = "BAKUDO_WORKER_RESULT";
export const WORKER_ERROR_PREFIX = "BAKUDO_WORKER_ERROR";

/**
 * @deprecated Replaced by {@link AttemptSpec} in the planAttempt → executeAttempt
 * pipeline (Phase 3). Kept for backward compatibility with legacy executeTask
 * callers. Remove in Phase 6.
 */
export type WorkerTaskSpec = TaskRequest & {
  timeoutSeconds?: number;
  maxOutputBytes?: number;
  heartbeatIntervalMs?: number;
};

export type WorkerTaskProgressEvent = TaskProgressEvent & {
  outputBytes?: number;
  stdoutBytes?: number;
  stderrBytes?: number;
  elapsedMs?: number;
  timedOut?: boolean;
  exitCode?: number | null;
  exitSignal?: string | null;
};

export type WorkerTaskResult = {
  schemaVersion: typeof BAKUDO_PROTOCOL_SCHEMA_VERSION;
  taskId: string;
  sessionId: string;
  status: "succeeded" | "failed";
  summary: string;
  startedAt?: string;
  finishedAt: string;
  exitCode: number | null;
  artifacts?: string[];
  command: string;
  cwd: string;
  shell: string;
  timeoutSeconds: number;
  durationMs: number;
  exitSignal: string | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  timedOut: boolean;
  assumeDangerousSkipPermissions: boolean;
};

export type WorkerRuntimeOptions = {
  shell?: string;
  timeoutSeconds?: number;
  maxOutputBytes?: number;
  heartbeatIntervalMs?: number;
  killGraceMs?: number;
  now?: () => Date;
  emit?: (event: WorkerTaskProgressEvent) => void;
};

type ByteCapture = {
  chunks: Buffer[];
  bytes: number;
  truncated: boolean;
};

const DEFAULT_TIMEOUT_SECONDS = 120;
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 5000;
const DEFAULT_KILL_GRACE_MS = 2000;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const clampPositiveInteger = (value: number, fallback: number): number =>
  Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;

const normalizeBase64 = (value: string): string => {
  const trimmed = value.trim().replace(/\s+/g, "");
  const base64 = trimmed.replace(/-/g, "+").replace(/_/g, "/");
  const remainder = base64.length % 4;
  return remainder === 0 ? base64 : `${base64}${"=".repeat(4 - remainder)}`;
};

const captureChunk = (capture: ByteCapture, chunk: Buffer, maxBytes: number): void => {
  if (capture.bytes >= maxBytes) {
    capture.truncated = true;
    return;
  }

  const remaining = maxBytes - capture.bytes;
  if (chunk.length <= remaining) {
    capture.chunks.push(chunk);
    capture.bytes += chunk.length;
    return;
  }

  capture.chunks.push(chunk.subarray(0, remaining));
  capture.bytes += remaining;
  capture.truncated = true;
};

const decodeJson = (encoded: string): unknown => {
  const normalized = normalizeBase64(encoded);
  const decoded = Buffer.from(normalized, "base64").toString("utf8");
  return JSON.parse(decoded) as unknown;
};

const makeCapture = (): ByteCapture => ({ chunks: [], bytes: 0, truncated: false });

const captureToString = (capture: ByteCapture): string =>
  Buffer.concat(capture.chunks, capture.bytes).toString("utf8");

const formatMessage = (goal: string): string => {
  const trimmed = goal.trim().replace(/\s+/g, " ");
  return trimmed.length <= 96 ? trimmed : `${trimmed.slice(0, 93)}...`;
};

/** Resolved spawn args + budget overrides from either AttemptSpec or legacy spec. */
type ResolvedCommand = {
  spawnArgs: [string, string[]];
  goalLabel: string;
  timeoutSeconds?: number;
  maxOutputBytes?: number;
  heartbeatIntervalMs?: number;
};

/** Detect taskKind → AttemptSpec dispatch; else legacy bash -lc goal. */
const resolveCommand = (spec: WorkerTaskSpec, shell: string): ResolvedCommand => {
  const raw = spec as Record<string, unknown>;
  if (typeof raw.taskKind === "string") {
    const as = (isObject(raw.attemptSpec) ? raw.attemptSpec : raw) as AttemptSpec;
    const cmd = dispatchTaskKind(as);
    const [exe = shell, ...args] = cmd.command;
    return {
      spawnArgs: [exe, args],
      goalLabel: cmd.command.join(" "),
      timeoutSeconds: as.budget.timeoutSeconds,
      maxOutputBytes: as.budget.maxOutputBytes,
      heartbeatIntervalMs: as.budget.heartbeatIntervalMs,
    };
  }
  return { spawnArgs: [shell, ["-lc", spec.goal]], goalLabel: spec.goal };
};

const nowIso = (now?: () => Date): string => (now ?? (() => new Date()))().toISOString();

const emitProgress = (
  emit: (event: WorkerTaskProgressEvent) => void,
  spec: WorkerTaskSpec,
  kind: WorkerTaskProgressEvent["kind"],
  status: WorkerTaskProgressEvent["status"],
  message: string,
  extra: Partial<WorkerTaskProgressEvent> = {},
): void => {
  emit({
    schemaVersion: BAKUDO_PROTOCOL_SCHEMA_VERSION,
    kind,
    taskId: spec.taskId,
    sessionId: spec.sessionId,
    status,
    message,
    timestamp: nowIso(),
    ...extra,
  });
};

const validateTaskSpec = (value: unknown): WorkerTaskSpec => {
  if (!isObject(value)) {
    throw new Error("invalid task spec: expected JSON object");
  }

  const schemaVersion = value.schemaVersion;
  if (schemaVersion !== BAKUDO_PROTOCOL_SCHEMA_VERSION) {
    throw new Error(
      `unsupported task spec schema version: ${String(schemaVersion)} (expected ${BAKUDO_PROTOCOL_SCHEMA_VERSION})`,
    );
  }

  const taskId = value.taskId;
  const sessionId = value.sessionId;
  const goal = value.goal;
  const assumeDangerousSkipPermissions = value.assumeDangerousSkipPermissions;

  if (typeof taskId !== "string" || taskId.trim().length === 0) {
    throw new Error("invalid task spec: missing taskId");
  }
  if (typeof sessionId !== "string" || sessionId.trim().length === 0) {
    throw new Error("invalid task spec: missing sessionId");
  }
  if (typeof goal !== "string" || goal.trim().length === 0) {
    throw new Error("invalid task spec: missing goal");
  }
  if (typeof assumeDangerousSkipPermissions !== "boolean") {
    throw new Error("invalid task spec: missing assumeDangerousSkipPermissions");
  }

  const cwd = value.cwd;
  const mode = value.mode;
  const streamId = value.streamId;
  const timeoutSeconds = value.timeoutSeconds;
  const maxOutputBytes = value.maxOutputBytes;
  const heartbeatIntervalMs = value.heartbeatIntervalMs;
  const taskKind = value.taskKind;
  const attemptSpec = value.attemptSpec;

  const spec: WorkerTaskSpec = {
    schemaVersion,
    taskId,
    sessionId,
    goal,
    assumeDangerousSkipPermissions,
    ...(typeof streamId === "string" && streamId.trim().length > 0 ? { streamId } : {}),
    ...(typeof cwd === "string" && cwd.trim().length > 0 ? { cwd } : {}),
    ...(mode === "build" || mode === "plan" ? { mode } : {}),
    ...(typeof timeoutSeconds === "number" && Number.isFinite(timeoutSeconds)
      ? { timeoutSeconds }
      : {}),
    ...(typeof maxOutputBytes === "number" && Number.isFinite(maxOutputBytes)
      ? { maxOutputBytes }
      : {}),
    ...(typeof heartbeatIntervalMs === "number" && Number.isFinite(heartbeatIntervalMs)
      ? { heartbeatIntervalMs }
      : {}),
  };

  const extended = spec as WorkerTaskSpec & {
    taskKind?: string;
    attemptSpec?: Record<string, unknown>;
  };
  if (typeof taskKind === "string" && taskKind.trim().length > 0) {
    extended.taskKind = taskKind;
  }
  if (isObject(attemptSpec)) {
    extended.attemptSpec = attemptSpec;
  }
  return extended;
};

export const decodeWorkerTaskSpec = (encoded: string): WorkerTaskSpec =>
  validateTaskSpec(decodeJson(encoded));

export const encodeWorkerEnvelope = (prefix: string, payload: unknown): string =>
  `${prefix} ${JSON.stringify(payload)}`;

export const parseWorkerTaskSpec = (argv: string[]): WorkerTaskSpec => {
  const specArg = argv.find(
    (arg) => arg === "--task-spec-b64" || arg.startsWith("--task-spec-b64="),
  );
  if (!specArg) {
    throw new Error("missing required argument --task-spec-b64");
  }

  const encoded = specArg.includes("=")
    ? specArg.slice("--task-spec-b64=".length)
    : (() => {
        const index = argv.indexOf(specArg);
        const value = argv[index + 1];
        if (value === undefined || value.startsWith("--")) {
          throw new Error("missing value for --task-spec-b64");
        }
        return value;
      })();

  return decodeWorkerTaskSpec(encoded);
};

export const workerResultStatusFromExitCode = (
  exitCode: number | null,
  timedOut: boolean,
): WorkerTaskResult["status"] => (exitCode === 0 && !timedOut ? "succeeded" : "failed");

export const runWorkerTask = async (
  spec: WorkerTaskSpec,
  options: WorkerRuntimeOptions = {},
): Promise<WorkerTaskResult> => {
  const runtimeProcess = process as unknown as {
    cwd?: () => string;
    env?: Record<string, string | undefined>;
  };
  const emit = options.emit ?? (() => undefined);
  const shell = options.shell ?? "bash";
  const resolved = resolveCommand(spec, shell);
  const timeoutSeconds = clampPositiveInteger(
    options.timeoutSeconds ??
      resolved.timeoutSeconds ??
      spec.timeoutSeconds ??
      DEFAULT_TIMEOUT_SECONDS,
    DEFAULT_TIMEOUT_SECONDS,
  );
  const maxOutputBytes = clampPositiveInteger(
    options.maxOutputBytes ??
      resolved.maxOutputBytes ??
      spec.maxOutputBytes ??
      DEFAULT_MAX_OUTPUT_BYTES,
    DEFAULT_MAX_OUTPUT_BYTES,
  );
  const heartbeatIntervalMs = clampPositiveInteger(
    options.heartbeatIntervalMs ??
      resolved.heartbeatIntervalMs ??
      spec.heartbeatIntervalMs ??
      DEFAULT_HEARTBEAT_INTERVAL_MS,
    DEFAULT_HEARTBEAT_INTERVAL_MS,
  );
  const killGraceMs = clampPositiveInteger(
    options.killGraceMs ?? DEFAULT_KILL_GRACE_MS,
    DEFAULT_KILL_GRACE_MS,
  );
  const cwd = spec.cwd ?? runtimeProcess.cwd?.() ?? ".";
  const startedAt = nowIso(options.now);

  emitProgress(emit, spec, "task.queued", "queued", "task accepted for execution", {
    percentComplete: 0,
  });
  emitProgress(
    emit,
    spec,
    "task.started",
    "running",
    `running ${formatMessage(resolved.goalLabel)}`,
  );

  const stdoutCapture = makeCapture();
  const stderrCapture = makeCapture();
  let exitCode: number | null = null;
  let exitSignal: string | null = null;
  let timedOut = false;
  let failedToSpawn: Error | null = null;

  const child = spawn(resolved.spawnArgs[0], resolved.spawnArgs[1], {
    cwd,
    env: runtimeProcess.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const heartbeat = setInterval(() => {
    const elapsedMs = Date.now() - Date.parse(startedAt);
    emitProgress(
      emit,
      spec,
      "task.progress",
      "running",
      `running for ${Math.max(0, elapsedMs)}ms`,
      {
        elapsedMs: Math.max(0, elapsedMs),
        stdoutBytes: stdoutCapture.bytes,
        stderrBytes: stderrCapture.bytes,
      },
    );
  }, heartbeatIntervalMs);
  heartbeat.unref?.();

  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    emitProgress(
      emit,
      spec,
      "task.progress",
      "running",
      `timeout after ${timeoutSeconds}s, stopping command`,
      {
        timedOut: true,
      },
    );
    child.kill("SIGTERM");
    const forceKill = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }, killGraceMs);
    forceKill.unref?.();
  }, timeoutSeconds * 1000);
  timeoutHandle.unref?.();

  child.stdout?.on("data", (chunk: Buffer) => {
    captureChunk(stdoutCapture, chunk, maxOutputBytes);
    emitProgress(emit, spec, "task.progress", "running", "captured stdout output", {
      stdoutBytes: stdoutCapture.bytes,
      stderrBytes: stderrCapture.bytes,
    });
  });

  child.stderr?.on("data", (chunk: Buffer) => {
    captureChunk(stderrCapture, chunk, maxOutputBytes);
    emitProgress(emit, spec, "task.progress", "running", "captured stderr output", {
      stdoutBytes: stdoutCapture.bytes,
      stderrBytes: stderrCapture.bytes,
    });
  });

  await new Promise<void>((resolve, reject) => {
    child.once("error", (error) => {
      failedToSpawn = error instanceof Error ? error : new Error(String(error));
      reject(failedToSpawn);
    });
    child.once("exit", (code, signal) => {
      exitCode = code;
      exitSignal = signal;
      resolve();
    });
  }).catch(() => undefined);

  clearInterval(heartbeat);
  clearTimeout(timeoutHandle);

  const finishedAt = nowIso(options.now);
  const stdout = captureToString(stdoutCapture);
  const stderr = captureToString(stderrCapture);
  const command = resolved.goalLabel;
  const status = failedToSpawn ? "failed" : workerResultStatusFromExitCode(exitCode, timedOut);

  const summary = failedToSpawn
    ? `failed to start command: ${(failedToSpawn as Error).message}`
    : timedOut
      ? `command timed out after ${timeoutSeconds}s`
      : exitCode === 0
        ? "command completed successfully"
        : `command exited with code ${String(exitCode ?? "unknown")}`;

  const result: WorkerTaskResult = {
    schemaVersion: BAKUDO_PROTOCOL_SCHEMA_VERSION,
    taskId: spec.taskId,
    sessionId: spec.sessionId,
    status,
    summary,
    exitCode,
    startedAt,
    finishedAt,
    ...(stdout || stderr ? { artifacts: ["stdout", "stderr"] } : {}),
    command,
    cwd,
    shell,
    timeoutSeconds,
    durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
    exitSignal,
    stdout,
    stderr,
    stdoutTruncated: stdoutCapture.truncated,
    stderrTruncated: stderrCapture.truncated,
    timedOut,
    assumeDangerousSkipPermissions: spec.assumeDangerousSkipPermissions,
  };

  if (status === "succeeded") {
    emitProgress(emit, spec, "task.completed", "succeeded", result.summary, {
      exitCode,
      exitSignal,
      elapsedMs: result.durationMs,
      stdoutBytes: stdoutCapture.bytes,
      stderrBytes: stderrCapture.bytes,
    });
  } else {
    emitProgress(emit, spec, "task.failed", "failed", result.summary, {
      exitCode,
      exitSignal,
      timedOut,
      elapsedMs: result.durationMs,
      stdoutBytes: stdoutCapture.bytes,
      stderrBytes: stderrCapture.bytes,
    });
  }

  return result;
};

export const serializeWorkerEvent = (event: WorkerTaskProgressEvent): string =>
  encodeWorkerEnvelope(WORKER_EVENT_PREFIX, event);

export const serializeWorkerResult = (result: WorkerTaskResult): string =>
  encodeWorkerEnvelope(WORKER_RESULT_PREFIX, result);

export const serializeWorkerError = (message: string, details?: Record<string, unknown>): string =>
  encodeWorkerEnvelope(WORKER_ERROR_PREFIX, {
    schemaVersion: BAKUDO_PROTOCOL_SCHEMA_VERSION,
    message,
    ...(details ?? {}),
  });
