import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

import type { AttemptSpec, ExecutionProfile } from "./attemptProtocol.js";
import {
  BAKUDO_PROTOCOL_SCHEMA_VERSION,
  type TaskProgressEvent,
  type TaskRequest,
} from "./protocol.js";
import { dispatchTaskKind } from "./worker/taskKinds.js";

export const WORKER_EVENT_PREFIX = "BAKUDO_WORKER_EVENT";
export const WORKER_RESULT_PREFIX = "BAKUDO_WORKER_RESULT";
export const WORKER_ERROR_PREFIX = "BAKUDO_WORKER_ERROR";

export type LegacyWorkerRequest = TaskRequest & {
  stdin?: string;
};

export type WorkerDispatchInput = AttemptSpec | LegacyWorkerRequest;

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
  stdin?: string;
  executionProfile?: ExecutionProfile;
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
const ABOX_GUEST_WORKSPACE_CWD = "/workspace";
const DEFAULT_EXECUTION_PROFILE: ExecutionProfile = {
  agentBackend: "codex exec --dangerously-bypass-approvals-and-sandbox",
  sandboxLifecycle: "ephemeral",
  candidatePolicy: "discard",
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isAttemptSpec = (value: WorkerDispatchInput): value is AttemptSpec =>
  value.schemaVersion === 3;

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");

const isObjectArray = (value: unknown): value is Array<Record<string, unknown>> =>
  Array.isArray(value) && value.every((entry) => isObject(entry));

const isExecutionProfile = (value: unknown): value is ExecutionProfile => {
  if (!isObject(value)) {
    return false;
  }
  return (
    typeof value.agentBackend === "string" &&
    (value.sandboxLifecycle === "preserved" || value.sandboxLifecycle === "ephemeral") &&
    (value.candidatePolicy === "auto_apply" ||
      value.candidatePolicy === "manual_apply" ||
      value.candidatePolicy === "discard")
  );
};

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
  stdin?: string;
  timeoutSeconds?: number;
  maxOutputBytes?: number;
  heartbeatIntervalMs?: number;
};

/** Resolve AttemptSpec dispatch; else fall back to legacy bash -lc goal. */
const resolveCommand = (
  spec: WorkerDispatchInput,
  shell: string,
  executionProfile?: ExecutionProfile,
  stdinOverride?: string,
): ResolvedCommand => {
  if (isAttemptSpec(spec)) {
    const profile = isExecutionProfile(executionProfile)
      ? executionProfile
      : DEFAULT_EXECUTION_PROFILE;
    const cmd = dispatchTaskKind(spec, profile);
    const [exe = shell, ...args] = cmd.command;
    const resolvedStdin = cmd.stdin ?? stdinOverride;
    return {
      spawnArgs: [exe, args],
      goalLabel: cmd.command.join(" "),
      ...(typeof resolvedStdin === "string" ? { stdin: resolvedStdin } : {}),
      timeoutSeconds: spec.budget.timeoutSeconds,
      maxOutputBytes: spec.budget.maxOutputBytes,
      heartbeatIntervalMs: spec.budget.heartbeatIntervalMs,
    };
  }
  const resolvedStdin = spec.stdin ?? stdinOverride;
  return {
    spawnArgs: [shell, ["-lc", spec.goal]],
    goalLabel: spec.goal,
    ...(typeof resolvedStdin === "string" ? { stdin: resolvedStdin } : {}),
    ...(spec.timeoutSeconds === undefined ? {} : { timeoutSeconds: spec.timeoutSeconds }),
    ...(spec.maxOutputBytes === undefined ? {} : { maxOutputBytes: spec.maxOutputBytes }),
    ...(spec.heartbeatIntervalMs === undefined
      ? {}
      : { heartbeatIntervalMs: spec.heartbeatIntervalMs }),
  };
};

const nowIso = (now?: () => Date): string => (now ?? (() => new Date()))().toISOString();

const resolveWorkingDirectory = (spec: WorkerDispatchInput, fallbackCwd: string): string => {
  if (!isAttemptSpec(spec)) {
    return spec.cwd ?? fallbackCwd;
  }
  if (existsSync(ABOX_GUEST_WORKSPACE_CWD)) {
    return ABOX_GUEST_WORKSPACE_CWD;
  }
  if (existsSync(spec.cwd)) {
    return spec.cwd;
  }
  return fallbackCwd;
};

const emitProgress = (
  emit: (event: WorkerTaskProgressEvent) => void,
  spec: WorkerDispatchInput,
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

const formatValidationError = (label: string, value: unknown): never => {
  throw new Error(`unsupported worker input schema version: ${String(value)} (${label})`);
};

const invalidAttemptSpec = (message: string): never => {
  throw new Error(`invalid attempt spec: ${message}`);
};

const validateLegacyWorkerRequest = (value: unknown): LegacyWorkerRequest => {
  if (!isObject(value)) {
    throw new Error("invalid legacy worker request: expected JSON object");
  }

  const schemaVersion = value.schemaVersion;
  if (schemaVersion !== BAKUDO_PROTOCOL_SCHEMA_VERSION) {
    formatValidationError(`expected ${BAKUDO_PROTOCOL_SCHEMA_VERSION}`, schemaVersion);
  }

  const taskId = value.taskId;
  const sessionId = value.sessionId;
  const goal = value.goal;
  const assumeDangerousSkipPermissions = value.assumeDangerousSkipPermissions;

  if (typeof taskId !== "string" || taskId.trim().length === 0) {
    throw new Error("invalid legacy worker request: missing taskId");
  }
  if (typeof sessionId !== "string" || sessionId.trim().length === 0) {
    throw new Error("invalid legacy worker request: missing sessionId");
  }
  if (typeof goal !== "string" || goal.trim().length === 0) {
    throw new Error("invalid legacy worker request: missing goal");
  }
  if (typeof assumeDangerousSkipPermissions !== "boolean") {
    throw new Error("invalid legacy worker request: missing assumeDangerousSkipPermissions");
  }

  const cwd = value.cwd;
  const mode = value.mode;
  const streamId = value.streamId;
  const timeoutSeconds = value.timeoutSeconds;
  const maxOutputBytes = value.maxOutputBytes;
  const heartbeatIntervalMs = value.heartbeatIntervalMs;
  const stdin = value.stdin;

  return {
    schemaVersion: BAKUDO_PROTOCOL_SCHEMA_VERSION,
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
    ...(typeof stdin === "string" ? { stdin } : {}),
  };
};

const validateAttemptSpec = (value: unknown): AttemptSpec => {
  if (!isObject(value)) {
    invalidAttemptSpec("expected JSON object");
  }
  const spec = value as Record<string, unknown>;
  if (spec.schemaVersion !== 3) {
    invalidAttemptSpec(`schemaVersion: expected 3, got ${String(spec.schemaVersion)}`);
  }
  if (typeof spec.sessionId !== "string" || spec.sessionId.trim().length === 0) {
    invalidAttemptSpec("sessionId: expected non-empty string");
  }
  if (typeof spec.turnId !== "string" || spec.turnId.trim().length === 0) {
    invalidAttemptSpec("turnId: expected non-empty string");
  }
  if (typeof spec.attemptId !== "string" || spec.attemptId.trim().length === 0) {
    invalidAttemptSpec("attemptId: expected non-empty string");
  }
  if (typeof spec.taskId !== "string" || spec.taskId.trim().length === 0) {
    invalidAttemptSpec("taskId: expected non-empty string");
  }
  if (typeof spec.intentId !== "string" || spec.intentId.trim().length === 0) {
    invalidAttemptSpec("intentId: expected non-empty string");
  }
  if (spec.mode !== "build" && spec.mode !== "plan") {
    invalidAttemptSpec("mode: expected build or plan");
  }
  if (
    spec.taskKind !== "assistant_job" &&
    spec.taskKind !== "explicit_command" &&
    spec.taskKind !== "verification_check"
  ) {
    invalidAttemptSpec("taskKind: expected assistant_job, explicit_command, or verification_check");
  }
  if (typeof spec.prompt !== "string") {
    invalidAttemptSpec("prompt: expected string");
  }
  if (!isStringArray(spec.instructions)) {
    invalidAttemptSpec("instructions: expected string[]");
  }
  if (typeof spec.cwd !== "string" || spec.cwd.trim().length === 0) {
    invalidAttemptSpec("cwd: expected non-empty string");
  }
  if (!isObject(spec.execution)) {
    invalidAttemptSpec("execution: expected object");
  }
  const execution = spec.execution as Record<string, unknown>;
  if (execution.engine !== "agent_cli" && execution.engine !== "shell") {
    invalidAttemptSpec("execution.engine: expected agent_cli or shell");
  }
  if (execution.command !== undefined && !isStringArray(execution.command)) {
    invalidAttemptSpec("execution.command: expected string[]");
  }
  if (!isObject(spec.permissions)) {
    invalidAttemptSpec("permissions: expected object");
  }
  const permissions = spec.permissions as Record<string, unknown>;
  if (!isObjectArray(permissions.rules)) {
    invalidAttemptSpec("permissions.rules: expected object[]");
  }
  if (typeof permissions.allowAllTools !== "boolean") {
    invalidAttemptSpec("permissions.allowAllTools: expected boolean");
  }
  if (typeof permissions.noAskUser !== "boolean") {
    invalidAttemptSpec("permissions.noAskUser: expected boolean");
  }
  if (!isObject(spec.budget)) {
    invalidAttemptSpec("budget: expected object");
  }
  const budget = spec.budget as Record<string, unknown>;
  if (typeof budget.timeoutSeconds !== "number" || !Number.isFinite(budget.timeoutSeconds)) {
    invalidAttemptSpec("budget.timeoutSeconds: expected finite number");
  }
  if (typeof budget.maxOutputBytes !== "number" || !Number.isFinite(budget.maxOutputBytes)) {
    invalidAttemptSpec("budget.maxOutputBytes: expected finite number");
  }
  if (
    typeof budget.heartbeatIntervalMs !== "number" ||
    !Number.isFinite(budget.heartbeatIntervalMs)
  ) {
    invalidAttemptSpec("budget.heartbeatIntervalMs: expected finite number");
  }
  if (
    budget.tokenBudget !== undefined &&
    (typeof budget.tokenBudget !== "number" || !Number.isFinite(budget.tokenBudget))
  ) {
    invalidAttemptSpec("budget.tokenBudget: expected finite number");
  }
  if (!isObjectArray(spec.acceptanceChecks)) {
    invalidAttemptSpec("acceptanceChecks: expected object[]");
  }
  if (!isObjectArray(spec.artifactRequests)) {
    invalidAttemptSpec("artifactRequests: expected object[]");
  }

  return spec as AttemptSpec;
};

const validateWorkerInput = (value: unknown): WorkerDispatchInput => {
  if (!isObject(value)) {
    throw new Error("invalid worker input: expected JSON object");
  }
  if (value.schemaVersion === 3) {
    return validateAttemptSpec(value);
  }
  return validateLegacyWorkerRequest(value);
};

export const decodeWorkerInput = (encoded: string): WorkerDispatchInput =>
  validateWorkerInput(decodeJson(encoded));

export const decodeExecutionProfile = (encoded: string): ExecutionProfile => {
  const parsed = decodeJson(encoded);
  if (!isExecutionProfile(parsed)) {
    throw new Error(
      "invalid execution profile: expected agentBackend plus valid sandboxLifecycle and candidatePolicy",
    );
  }
  return parsed;
};

export const encodeWorkerEnvelope = (prefix: string, payload: unknown): string =>
  `${prefix} ${JSON.stringify(payload)}`;

export const workerResultStatusFromExitCode = (
  exitCode: number | null,
  timedOut: boolean,
): WorkerTaskResult["status"] => (exitCode === 0 && !timedOut ? "succeeded" : "failed");

export const runWorkerTask = async (
  spec: WorkerDispatchInput,
  options: WorkerRuntimeOptions = {},
): Promise<WorkerTaskResult> => {
  const runtimeProcess = process as unknown as {
    cwd?: () => string;
    env?: Record<string, string | undefined>;
  };
  const emit = options.emit ?? (() => undefined);
  const shell = options.shell ?? "bash";
  const resolved = resolveCommand(spec, shell, options.executionProfile, options.stdin);
  const timeoutSeconds = clampPositiveInteger(
    options.timeoutSeconds ??
      resolved.timeoutSeconds ??
      (isAttemptSpec(spec) ? undefined : spec.timeoutSeconds) ??
      DEFAULT_TIMEOUT_SECONDS,
    DEFAULT_TIMEOUT_SECONDS,
  );
  const maxOutputBytes = clampPositiveInteger(
    options.maxOutputBytes ??
      resolved.maxOutputBytes ??
      (isAttemptSpec(spec) ? undefined : spec.maxOutputBytes) ??
      DEFAULT_MAX_OUTPUT_BYTES,
    DEFAULT_MAX_OUTPUT_BYTES,
  );
  const heartbeatIntervalMs = clampPositiveInteger(
    options.heartbeatIntervalMs ??
      resolved.heartbeatIntervalMs ??
      (isAttemptSpec(spec) ? undefined : spec.heartbeatIntervalMs) ??
      DEFAULT_HEARTBEAT_INTERVAL_MS,
    DEFAULT_HEARTBEAT_INTERVAL_MS,
  );
  const killGraceMs = clampPositiveInteger(
    options.killGraceMs ?? DEFAULT_KILL_GRACE_MS,
    DEFAULT_KILL_GRACE_MS,
  );
  const cwd = resolveWorkingDirectory(spec, runtimeProcess.cwd?.() ?? ".");
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

  const hasStdin = typeof resolved.stdin === "string";
  const child = spawn(resolved.spawnArgs[0], resolved.spawnArgs[1], {
    cwd,
    env: runtimeProcess.env,
    stdio: [hasStdin ? "pipe" : "ignore", "pipe", "pipe"],
  });
  if (hasStdin && child.stdin) {
    child.stdin.write(resolved.stdin);
    child.stdin.end();
  }

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
    assumeDangerousSkipPermissions: isAttemptSpec(spec)
      ? spec.permissions.allowAllTools
      : spec.assumeDangerousSkipPermissions,
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
