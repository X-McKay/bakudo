import { readFile } from "node:fs/promises";

import { ABoxAdapter } from "./aboxAdapter.js";
import type { AttemptSpec } from "./attemptProtocol.js";
import { DEFAULT_ENV_POLICY, filterEnv, type EnvPolicy } from "./host/envPolicy.js";
import {
  getCachedWorkerCapabilities,
  negotiateAttemptAgainstCapabilities,
  type ProbeOutcome,
} from "./host/workerCapabilities.js";
import { BAKUDO_PROTOCOL_SCHEMA_VERSION, type TaskResult } from "./protocol.js";
import {
  WORKER_ERROR_PREFIX,
  WORKER_EVENT_PREFIX,
  WORKER_RESULT_PREFIX,
  type WorkerTaskProgressEvent,
  type WorkerTaskResult,
  type WorkerTaskSpec,
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
  workerRuntimeJs: string;
  workerCliJs: string;
};

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
  return readFile(url, "utf8");
};

const loadWorkerModuleSources = async (): Promise<WorkerModuleSources> => ({
  packageJson: JSON.stringify({ type: "module" }, null, 2),
  protocolJs: await resolveDistSource("./protocol.js"),
  workerRuntimeJs: await resolveDistSource("./workerRuntime.js"),
  workerCliJs: await resolveDistSource("./workerCli.js"),
});

const buildWorkerLaunchCommand = async (
  spec: WorkerTaskSpec,
  overrides: {
    shell?: string;
    timeoutSeconds?: number;
    maxOutputBytes?: number;
    heartbeatIntervalMs?: number;
    killGraceMs?: number;
  } = {},
): Promise<string> => {
  const sources = await loadWorkerModuleSources();
  const encodedSpec = Buffer.from(JSON.stringify(spec), "utf8").toString("base64");
  const commandArgs = [
    "node",
    '"$tmpdir/workerCli.js"',
    "--task-spec-b64",
    shellEscape(encodedSpec),
    "--shell",
    shellEscape(overrides.shell ?? "bash"),
    "--timeout-seconds",
    String(overrides.timeoutSeconds ?? spec.timeoutSeconds ?? 120),
    "--max-output-bytes",
    String(overrides.maxOutputBytes ?? spec.maxOutputBytes ?? 256 * 1024),
    "--heartbeat-ms",
    String(overrides.heartbeatIntervalMs ?? spec.heartbeatIntervalMs ?? 5000),
    "--kill-grace-ms",
    String(overrides.killGraceMs ?? 2000),
  ].join(" ");

  return [
    "set -euo pipefail",
    'tmpdir="$(mktemp -d)"',
    renderHereDoc('"$tmpdir/package.json"', `${sources.packageJson}\n`, "BAKUDO_PACKAGE_JSON"),
    renderHereDoc('"$tmpdir/protocol.js"', sources.protocolJs, "BAKUDO_PROTOCOL_JS"),
    renderHereDoc(
      '"$tmpdir/workerRuntime.js"',
      sources.workerRuntimeJs,
      "BAKUDO_WORKER_RUNTIME_JS",
    ),
    renderHereDoc('"$tmpdir/workerCli.js"', sources.workerCliJs, "BAKUDO_WORKER_CLI_JS"),
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
  spec: WorkerTaskSpec,
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
    command: spec.goal,
    cwd: spec.cwd ?? ".",
    shell: "bash",
    timeoutSeconds: spec.timeoutSeconds ?? 120,
    durationMs: 0,
    exitSignal: typeof metadata?.signal === "string" ? metadata.signal : null,
    stdout: rawOutput,
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: String(metadata?.errorType ?? "") === "timeout",
    assumeDangerousSkipPermissions: spec.assumeDangerousSkipPermissions,
  };
};

const parseExecutionOutput = (
  spec: WorkerTaskSpec,
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
 * Convert an {@link AttemptSpec} to a {@link WorkerTaskSpec} so the existing
 * worker launch pipeline (heredocs, workerCli.js, workerRuntime.js) can
 * execute it. The worker runtime inspects `taskKind` to decide the
 * task-kind dispatch path (PR10); specs without `taskKind` fall through to
 * the legacy `goal`-as-command path.
 */
export const attemptSpecToWorkerSpec = (spec: AttemptSpec): WorkerTaskSpec => {
  const base: WorkerTaskSpec = {
    schemaVersion: BAKUDO_PROTOCOL_SCHEMA_VERSION,
    taskId: spec.taskId,
    sessionId: spec.sessionId,
    goal: spec.prompt,
    mode: spec.mode,
    cwd: spec.cwd,
    timeoutSeconds: spec.budget.timeoutSeconds,
    maxOutputBytes: spec.budget.maxOutputBytes,
    heartbeatIntervalMs: spec.budget.heartbeatIntervalMs,
    assumeDangerousSkipPermissions: spec.permissions.allowAllTools,
  };
  // Phase 3 v3 fields — workerRuntime reads `taskKind` + `attemptSpec` via
  // duck-typing for task-kind dispatch. Not on the TS type (legacy shape)
  // so we assign post-construction.
  const extended = base as WorkerTaskSpec & { taskKind: string; attemptSpec: AttemptSpec };
  extended.taskKind = spec.taskKind;
  extended.attemptSpec = spec;
  return extended;
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

  public async runTask(
    spec: WorkerTaskSpec,
    overrides: {
      shell?: string;
      timeoutSeconds?: number;
      maxOutputBytes?: number;
      heartbeatIntervalMs?: number;
      killGraceMs?: number;
    } = {},
    handlers: TaskRunnerHandlers = {},
  ): Promise<TaskExecutionRecord> {
    const command = await buildWorkerLaunchCommand(spec, overrides);
    const timeoutSeconds = (overrides.timeoutSeconds ?? spec.timeoutSeconds ?? 120) + 20;
    const streamId = spec.streamId ?? spec.taskId;
    // Phase 6 W5 — route the host env through the allowlist BEFORE building
    // the spawn. Default policy has an empty allowlist, so workers see a
    // clean env unless the user has opted in to specific names.
    const filteredEnv = filterEnv(this.envSource(), this.envPolicy);
    let rawOutput = "";
    const execution = await this.adapter.runInStreamLive(
      streamId,
      command,
      timeoutSeconds,
      {
        onStdout: (chunk) => {
          rawOutput += chunk;
        },
        onStderr: (chunk) => {
          rawOutput += chunk;
        },
      },
      filteredEnv,
    );
    const output = rawOutput.length > 0 ? rawOutput : execution.output;
    return parseExecutionOutput(spec, output, execution.ok, execution.metadata, handlers);
  }

  /**
   * Run an {@link AttemptSpec} through the worker pipeline. Converts the
   * spec to a {@link WorkerTaskSpec}, delegates to {@link runTask}.
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
    const workerSpec = attemptSpecToWorkerSpec(spec);
    return this.runTask(workerSpec, overrides, handlers);
  }
}

export const toTaskResult = (result: WorkerTaskResult): TaskResult => result;
