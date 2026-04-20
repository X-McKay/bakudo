import { readFile } from "node:fs/promises";

import { ABoxAdapter } from "./aboxAdapter.js";
import type { AttemptSpec, ExecutionProfile } from "./attemptProtocol.js";
import { DEFAULT_ENV_POLICY, filterEnv, type EnvPolicy } from "./host/envPolicy.js";
import { buildAboxShellCommandArgs, generateSandboxTaskId } from "./host/sandboxLifecycle.js";
import {
  getCachedWorkerCapabilities,
  negotiateAttemptAgainstCapabilities,
  type ProbeOutcome,
} from "./host/workerCapabilities.js";
import { BAKUDO_PROTOCOL_SCHEMA_VERSION, type TaskRequest, type TaskResult } from "./protocol.js";
import {
  WORKER_ERROR_PREFIX,
  WORKER_EVENT_PREFIX,
  WORKER_RESULT_PREFIX,
  type LegacyWorkerRequest,
  type WorkerDispatchInput,
  type WorkerTaskProgressEvent,
  type WorkerTaskResult,
} from "./workerRuntime.js";

export type TaskExecutionRecord = {
  events: WorkerTaskProgressEvent[];
  result: WorkerTaskResult;
  workerErrors: Array<Record<string, unknown>>;
  rawOutput: string;
  ok: boolean;
  metadata?: Record<string, unknown>;
};

export type TaskRunnerHandlers = {
  onEvent?: (event: WorkerTaskProgressEvent) => void;
  onWorkerError?: (error: Record<string, unknown>) => void;
};

type WorkerModuleSources = {
  packageJson: string;
  protocolJs: string;
  attemptPathJs: string;
  mainModuleJs: string;
  workerRuntimeJs: string;
  workerCliJs: string;
  workerTaskKindsJs: string;
  workerAssistantJobRunnerJs: string;
  workerCommandRunnerJs: string;
  workerCheckRunnerJs: string;
};

const DEFAULT_WORKER_EXECUTION_PROFILE: ExecutionProfile = {
  agentBackend: "codex exec --dangerously-bypass-approvals-and-sandbox",
  sandboxLifecycle: "ephemeral",
  candidatePolicy: "discard",
};

const isAttemptSpec = (spec: WorkerDispatchInput): spec is AttemptSpec => spec.schemaVersion === 3;
const inputTimeoutSeconds = (spec: WorkerDispatchInput): number | undefined =>
  isAttemptSpec(spec) ? spec.budget.timeoutSeconds : spec.timeoutSeconds;
const inputMaxOutputBytes = (spec: WorkerDispatchInput): number | undefined =>
  isAttemptSpec(spec) ? spec.budget.maxOutputBytes : spec.maxOutputBytes;
const inputHeartbeatIntervalMs = (spec: WorkerDispatchInput): number | undefined =>
  isAttemptSpec(spec) ? spec.budget.heartbeatIntervalMs : spec.heartbeatIntervalMs;
const inputCommandLabel = (spec: WorkerDispatchInput): string =>
  isAttemptSpec(spec) ? spec.prompt : spec.goal;
const inputReportedCwd = (spec: WorkerDispatchInput): string =>
  isAttemptSpec(spec) ? "/workspace" : (spec.cwd ?? ".");
const inputAssumeDangerousSkipPermissions = (spec: WorkerDispatchInput): boolean =>
  isAttemptSpec(spec) ? spec.permissions.allowAllTools : spec.assumeDangerousSkipPermissions;
const inputRepoRoot = (spec: WorkerDispatchInput): string | undefined => spec.cwd;

const shellEscape = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

const chooseDelimiter = (content: string, base: string): string => {
  let delimiter = base;
  while (content.includes(delimiter)) {
    delimiter = `${delimiter}_X`;
  }
  return delimiter;
};

const renderHereDoc = (targetPath: string, content: string, base: string): string => {
  const delimiter = chooseDelimiter(content, base);
  return [`cat <<'${delimiter}' > ${targetPath}`, content, delimiter].join("\n");
};

const resolveDistSource = async (relativePath: string): Promise<string> => {
  const url = new URL(relativePath, import.meta.url);
  try {
    return await readFile(url, "utf8");
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== "ENOENT" || !relativePath.endsWith(".js")) {
      throw error;
    }
    const sourceUrl = new URL(relativePath.replace(/\.js$/u, ".ts"), import.meta.url);
    return readFile(sourceUrl, "utf8");
  }
};

const loadWorkerModuleSources = async (): Promise<WorkerModuleSources> => ({
  packageJson: JSON.stringify({ type: "module" }, null, 2),
  protocolJs: await resolveDistSource("./protocol.js"),
  attemptPathJs: await resolveDistSource("./attemptPath.js"),
  mainModuleJs: await resolveDistSource("./mainModule.js"),
  workerRuntimeJs: await resolveDistSource("./workerRuntime.js"),
  workerCliJs: await resolveDistSource("./workerCli.js"),
  workerTaskKindsJs: await resolveDistSource("./worker/taskKinds.js"),
  workerAssistantJobRunnerJs: await resolveDistSource("./worker/assistantJobRunner.js"),
  workerCommandRunnerJs: await resolveDistSource("./worker/commandRunner.js"),
  workerCheckRunnerJs: await resolveDistSource("./worker/checkRunner.js"),
});

const buildWorkerLaunchCommand = async (
  spec: WorkerDispatchInput,
  overrides: {
    shell?: string;
    timeoutSeconds?: number;
    maxOutputBytes?: number;
    heartbeatIntervalMs?: number;
    killGraceMs?: number;
  } = {},
  executionProfile?: ExecutionProfile,
): Promise<string> => {
  const sources = await loadWorkerModuleSources();
  const encodedSpec = Buffer.from(JSON.stringify(spec), "utf8").toString("base64");
  const encodedProfile =
    executionProfile === undefined
      ? undefined
      : Buffer.from(JSON.stringify(executionProfile), "utf8").toString("base64");
  const commandArgs = [
    "node",
    '"$tmpdir/workerCli.js"',
    "--input-b64",
    shellEscape(encodedSpec),
    ...(encodedProfile === undefined
      ? []
      : ["--execution-profile-b64", shellEscape(encodedProfile)]),
    "--shell",
    shellEscape(overrides.shell ?? "bash"),
    "--timeout-seconds",
    String(overrides.timeoutSeconds ?? inputTimeoutSeconds(spec) ?? 120),
    "--max-output-bytes",
    String(overrides.maxOutputBytes ?? inputMaxOutputBytes(spec) ?? 256 * 1024),
    "--heartbeat-ms",
    String(overrides.heartbeatIntervalMs ?? inputHeartbeatIntervalMs(spec) ?? 5000),
    "--kill-grace-ms",
    String(overrides.killGraceMs ?? 2000),
  ].join(" ");

  return [
    "set -euo pipefail",
    'tmpdir="$(mktemp -d)"',
    'mkdir -p "$tmpdir/worker"',
    renderHereDoc('"$tmpdir/package.json"', `${sources.packageJson}\n`, "BAKUDO_PACKAGE_JSON"),
    renderHereDoc('"$tmpdir/protocol.js"', sources.protocolJs, "BAKUDO_PROTOCOL_JS"),
    renderHereDoc('"$tmpdir/attemptPath.js"', sources.attemptPathJs, "BAKUDO_ATTEMPT_PATH_JS"),
    renderHereDoc('"$tmpdir/mainModule.js"', sources.mainModuleJs, "BAKUDO_MAIN_MODULE_JS"),
    renderHereDoc(
      '"$tmpdir/workerRuntime.js"',
      sources.workerRuntimeJs,
      "BAKUDO_WORKER_RUNTIME_JS",
    ),
    renderHereDoc('"$tmpdir/workerCli.js"', sources.workerCliJs, "BAKUDO_WORKER_CLI_JS"),
    renderHereDoc(
      '"$tmpdir/worker/taskKinds.js"',
      sources.workerTaskKindsJs,
      "BAKUDO_WORKER_TASK_KINDS_JS",
    ),
    renderHereDoc(
      '"$tmpdir/worker/assistantJobRunner.js"',
      sources.workerAssistantJobRunnerJs,
      "BAKUDO_WORKER_ASSISTANT_JOB_RUNNER_JS",
    ),
    renderHereDoc(
      '"$tmpdir/worker/commandRunner.js"',
      sources.workerCommandRunnerJs,
      "BAKUDO_WORKER_COMMAND_RUNNER_JS",
    ),
    renderHereDoc(
      '"$tmpdir/worker/checkRunner.js"',
      sources.workerCheckRunnerJs,
      "BAKUDO_WORKER_CHECK_RUNNER_JS",
    ),
    commandArgs,
  ].join("\n");
};

const parseWorkerEnvelope = <T>(line: string, prefix: string): T | null => {
  const trimmed = line.trim();
  if (!trimmed.startsWith(`${prefix} `)) {
    return null;
  }

  return JSON.parse(trimmed.slice(prefix.length + 1)) as T;
};

const toExitCode = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
};

const synthesizeResult = (
  spec: WorkerDispatchInput,
  rawOutput: string,
  workerErrors: Array<Record<string, unknown>>,
  metadata?: Record<string, unknown>,
): WorkerTaskResult => {
  const errorMessages = workerErrors
    .map((error) => error.message)
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  const summary =
    errorMessages[0] ??
    (rawOutput.trim().length > 0
      ? "worker finished without a structured result envelope"
      : "worker produced no output");

  return {
    schemaVersion: BAKUDO_PROTOCOL_SCHEMA_VERSION,
    taskId: spec.taskId,
    sessionId: spec.sessionId,
    status: "failed",
    summary,
    finishedAt: new Date().toISOString(),
    exitCode: toExitCode(metadata?.code) ?? 1,
    command: inputCommandLabel(spec),
    cwd: inputReportedCwd(spec),
    shell: "bash",
    timeoutSeconds: inputTimeoutSeconds(spec) ?? 120,
    durationMs: 0,
    exitSignal: typeof metadata?.signal === "string" ? metadata.signal : null,
    stdout: rawOutput,
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: String(metadata?.errorType ?? "") === "timeout",
    assumeDangerousSkipPermissions: inputAssumeDangerousSkipPermissions(spec),
  };
};

const parseExecutionOutput = (
  spec: WorkerDispatchInput,
  rawOutput: string,
  ok: boolean,
  metadata?: Record<string, unknown>,
  handlers: TaskRunnerHandlers = {},
): TaskExecutionRecord => {
  const events: WorkerTaskProgressEvent[] = [];
  const workerErrors: Array<Record<string, unknown>> = [];
  let result: WorkerTaskResult | null = null;

  for (const line of rawOutput.split(/\r?\n/)) {
    const event = parseWorkerEnvelope<WorkerTaskProgressEvent>(line, WORKER_EVENT_PREFIX);
    if (event !== null) {
      events.push(event);
      handlers.onEvent?.(event);
      continue;
    }

    const parsedResult = parseWorkerEnvelope<WorkerTaskResult>(line, WORKER_RESULT_PREFIX);
    if (parsedResult !== null) {
      result = parsedResult;
      continue;
    }

    const workerError = parseWorkerEnvelope<Record<string, unknown>>(line, WORKER_ERROR_PREFIX);
    if (workerError !== null) {
      workerErrors.push(workerError);
      handlers.onWorkerError?.(workerError);
    }
  }

  return {
    events,
    workerErrors,
    result: result ?? synthesizeResult(spec, rawOutput, workerErrors, metadata),
    rawOutput,
    ok,
    ...(metadata === undefined ? {} : { metadata }),
  };
};

/**
 * Optional override for the worker capability probe used by
 * {@link ABoxTaskRunner.runAttempt}. Tests inject a stub here to avoid
 * spawning a real abox; production callers omit it and the runner uses the
 * cached `abox --capabilities` probe keyed on the adapter's bin path.
 */
export type WorkerCapabilitiesProvider = (bin: string) => Promise<ProbeOutcome>;

/**
 * Wave 6c PR9 carryover #6 — the runner-scoped probe-failure emitter.
 * Receives the probe outcome, the bin path, and the attempt spec currently
 * being dispatched; called at most ONCE per {@link ABoxTaskRunner} instance
 * (runner-instance = session scope) on the first `runAttempt` whose probe
 * fell back. Production wiring pipes the call to the session event log
 * writer; tests capture the invocation.
 *
 * Kept sync — the runner calls the emitter fire-and-forget so dispatch
 * latency is unaffected. Implementations that need to write I/O should use
 * `void` on an async operation inside the callback.
 */
export type ProbeFailureEmitter = (input: {
  outcome: ProbeOutcome;
  bin: string;
  spec: AttemptSpec;
}) => void;

/**
 * Phase 6 W5 — snapshot of `process.env` used when the runner is constructed
 * without an explicit env source. Kept as a getter so tests can stub the
 * node global without a module-load race.
 */
const hostEnvSnapshot = (): Readonly<Record<string, string | undefined>> => {
  const g = globalThis as unknown as {
    process?: { env?: Record<string, string | undefined> };
  };
  return g.process?.env ?? {};
};

export class ABoxTaskRunner {
  /**
   * Wave 6c PR9 carryover #6 — ensures {@link ProbeFailureEmitter} fires at
   * most once per runner-instance lifetime. Runner instances map 1:1 to a
   * session (see `sessionController.buildRunnerContext` and the two
   * runner-construction sites in `sessionLifecycle`); once-per-runner ≡
   * once-per-session per probe failure, satisfying the scope rule.
   */
  private probeFailureEmitted = false;

  public constructor(
    private readonly adapter: ABoxAdapter,
    private readonly capabilitiesProvider: WorkerCapabilitiesProvider = (bin) =>
      getCachedWorkerCapabilities({ bin }),
    /**
     * Phase 6 W5 — the env policy to apply to the host env before spawning.
     * Default is {@link DEFAULT_ENV_POLICY} (empty allowlist). Callers that
     * want a wider allowlist (from config cascade or `BAKUDO_ENV_ALLOWLIST`)
     * inject a resolved {@link EnvPolicy} here.
     */
    private readonly envPolicy: EnvPolicy = DEFAULT_ENV_POLICY,
    /**
     * Phase 6 W5 — injectable host env so tests can assert the filter
     * without mutating real `process.env`. Production callers omit this and
     * the runner reads the live `process.env` at dispatch time.
     */
    private readonly envSource: () => Readonly<
      Record<string, string | undefined>
    > = hostEnvSnapshot,
    /**
     * Wave 6c PR9 carryover #6 — optional emitter invoked once per runner
     * lifetime on probe failure. Production callers pipe this to the event
     * log writer so observers see a `host.event_skipped` envelope with
     * `payload.skippedKind = "worker.capability_probe_failed"`. Omit the
     * emitter to disable the diagnostic (legacy behaviour).
     */
    private readonly probeFailureEmitter?: ProbeFailureEmitter,
  ) {}

  private async runDispatch(
    spec: WorkerDispatchInput,
    overrides: {
      shell?: string;
      timeoutSeconds?: number;
      maxOutputBytes?: number;
      heartbeatIntervalMs?: number;
      killGraceMs?: number;
    } = {},
    handlers: TaskRunnerHandlers = {},
    executionProfile?: ExecutionProfile,
  ): Promise<TaskExecutionRecord> {
    const profile = executionProfile ?? DEFAULT_WORKER_EXECUTION_PROFILE;
    const command = await buildWorkerLaunchCommand(spec, overrides, profile);
    const timeoutSeconds = (overrides.timeoutSeconds ?? inputTimeoutSeconds(spec) ?? 120) + 20;
    // Phase 6 W5 — route the host env through the allowlist BEFORE building
    // the spawn. Default policy has an empty allowlist, so workers see a
    // clean env unless the user has opted in to specific names.
    const filteredEnv = filterEnv(this.envSource(), this.envPolicy);
    const sandboxTaskId = generateSandboxTaskId(
      isAttemptSpec(spec) ? spec.attemptId : (spec.streamId ?? spec.taskId),
    );
    const args = buildAboxShellCommandArgs(sandboxTaskId, command, profile, inputRepoRoot(spec));
    let rawOutput = "";
    const execution = await this.adapter.spawnLive(
      args,
      timeoutSeconds,
      {
        onStdout: (chunk: string) => {
          rawOutput += chunk;
        },
        onStderr: (chunk: string) => {
          rawOutput += chunk;
        },
      },
      filteredEnv,
      { taskId: sandboxTaskId },
    );
    const output = rawOutput.length > 0 ? rawOutput : execution.output;
    return parseExecutionOutput(spec, output, execution.ok, execution.metadata, handlers);
  }

  public async runTask(
    spec: TaskRequest & { stdin?: string },
    overrides: {
      shell?: string;
      timeoutSeconds?: number;
      maxOutputBytes?: number;
      heartbeatIntervalMs?: number;
      killGraceMs?: number;
    } = {},
    handlers: TaskRunnerHandlers = {},
  ): Promise<TaskExecutionRecord> {
    return this.runDispatch(spec as LegacyWorkerRequest, overrides, handlers);
  }

  /**
   * Run an {@link AttemptSpec} through the worker pipeline using direct
   * AttemptSpec transport plus an optional execution profile.
   *
   * Phase 6 W3 — runs the worker capability negotiation against the cached
   * probe before dispatch. On a mismatch (protocol version, task kind, or
   * execution engine), throws {@link WorkerProtocolMismatchError} synchronously
   * so the host's error pipeline (exit code 4, JSON envelope, plain-text
   * banner, `inspect` view) handles the failure uniformly.
   */
  public async runAttempt(
    spec: AttemptSpec,
    overrides: {
      shell?: string;
      timeoutSeconds?: number;
      maxOutputBytes?: number;
      heartbeatIntervalMs?: number;
      killGraceMs?: number;
    } = {},
    handlers: TaskRunnerHandlers = {},
    executionProfile?: ExecutionProfile,
  ): Promise<TaskExecutionRecord> {
    const probe = await this.capabilitiesProvider(this.adapter.binPath);
    // Wave 6c PR9 carryover #6 — emit the deferred diagnostic envelope when
    // the probe fell back. Fires AT MOST ONCE per runner lifetime (a session
    // typically creates one runner, so this dedupes to once-per-session-per-
    // probe-failure). Successful probes never reach this branch, preserving
    // the "no emit when probe succeeds" invariant.
    if (
      !this.probeFailureEmitted &&
      this.probeFailureEmitter !== undefined &&
      probe.capabilities.source === "fallback_host_default" &&
      probe.fallbackReason !== undefined &&
      probe.fallbackReason.length > 0
    ) {
      this.probeFailureEmitted = true;
      try {
        this.probeFailureEmitter({ outcome: probe, bin: this.adapter.binPath, spec });
      } catch {
        // Diagnostic emission MUST NOT break dispatch. A failing emitter is
        // the observability layer's problem; the fallback itself is still
        // applied below.
      }
    }
    negotiateAttemptAgainstCapabilities({
      spec,
      capabilities: probe.capabilities,
      ...(probe.fallbackReason === undefined ? {} : { fallbackReason: probe.fallbackReason }),
    });
    return this.runDispatch(spec, overrides, handlers, executionProfile);
  }
}

export const toTaskResult = (result: WorkerTaskResult): TaskResult => result;
