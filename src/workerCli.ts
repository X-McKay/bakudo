#!/usr/bin/env node

import {
  BAKUDO_HOST_EXECUTION_ENGINES,
  BAKUDO_HOST_PROTOCOL_VERSIONS,
  BAKUDO_HOST_TASK_KINDS,
  type WorkerCapabilities,
} from "./protocol.js";
import {
  decodeExecutionProfile,
  decodeWorkerInput,
  runWorkerTask,
  serializeWorkerError,
  serializeWorkerEvent,
  serializeWorkerResult,
} from "./workerRuntime.js";
import { isMainModule } from "./mainModule.js";

export type WorkerCliArgs = {
  inputB64: string;
  executionProfileB64?: string;
  shell: string;
  timeoutSeconds: number;
  maxOutputBytes: number;
  heartbeatIntervalMs: number;
  killGraceMs: number;
  help: boolean;
  capabilities: boolean;
};

/**
 * Capabilities the in-VM `bakudo-worker` self-reports when invoked with
 * `--capabilities`. Mirrors the host's compile surface (Phase 6 W3) since
 * the worker runtime understands every kind/engine the host emits. Kept
 * stable as a JSON shape — the host's negotiation parser
 * (`probeWorkerCapabilities`) accepts exactly this layout.
 */
export const workerSelfCapabilities = (): WorkerCapabilities => ({
  protocolVersions: [...BAKUDO_HOST_PROTOCOL_VERSIONS],
  taskKinds: [...BAKUDO_HOST_TASK_KINDS],
  executionEngines: [...BAKUDO_HOST_EXECUTION_ENGINES],
  source: "probe",
});

const parsePositiveInteger = (
  value: string | undefined,
  fallback: number,
  name: string,
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
  if (typeof arg !== "string") {
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

  throw new Error(`unexpected argument reader call for ${arg}`);
};

export const parseWorkerArgs = (argv: string[]): WorkerCliArgs => {
  const result: WorkerCliArgs = {
    inputB64: "",
    shell: "bash",
    timeoutSeconds: 120,
    maxOutputBytes: 256 * 1024,
    heartbeatIntervalMs: 5000,
    killGraceMs: 2000,
    help: false,
    capabilities: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (typeof arg !== "string") {
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      result.help = true;
      continue;
    }

    if (arg === "--capabilities") {
      result.capabilities = true;
      continue;
    }

    if (arg === "--input-b64" || arg.startsWith("--input-b64=")) {
      const { value, consumed } = readLongFlag(argv, i, "--input-b64");
      result.inputB64 = value;
      i += consumed - 1;
      continue;
    }

    if (arg === "--execution-profile-b64" || arg.startsWith("--execution-profile-b64=")) {
      const { value, consumed } = readLongFlag(argv, i, "--execution-profile-b64");
      result.executionProfileB64 = value;
      i += consumed - 1;
      continue;
    }

    if (arg === "--shell" || arg.startsWith("--shell=")) {
      const { value, consumed } = readLongFlag(argv, i, "--shell");
      result.shell = value;
      i += consumed - 1;
      continue;
    }

    if (arg === "--timeout-seconds" || arg.startsWith("--timeout-seconds=")) {
      const { value, consumed } = readLongFlag(argv, i, "--timeout-seconds");
      result.timeoutSeconds = parsePositiveInteger(
        value,
        result.timeoutSeconds,
        "--timeout-seconds",
      );
      i += consumed - 1;
      continue;
    }

    if (arg === "--max-output-bytes" || arg.startsWith("--max-output-bytes=")) {
      const { value, consumed } = readLongFlag(argv, i, "--max-output-bytes");
      result.maxOutputBytes = parsePositiveInteger(
        value,
        result.maxOutputBytes,
        "--max-output-bytes",
      );
      i += consumed - 1;
      continue;
    }

    if (arg === "--heartbeat-ms" || arg.startsWith("--heartbeat-ms=")) {
      const { value, consumed } = readLongFlag(argv, i, "--heartbeat-ms");
      result.heartbeatIntervalMs = parsePositiveInteger(
        value,
        result.heartbeatIntervalMs,
        "--heartbeat-ms",
      );
      i += consumed - 1;
      continue;
    }

    if (arg === "--kill-grace-ms" || arg.startsWith("--kill-grace-ms=")) {
      const { value, consumed } = readLongFlag(argv, i, "--kill-grace-ms");
      result.killGraceMs = parsePositiveInteger(value, result.killGraceMs, "--kill-grace-ms");
      i += consumed - 1;
      continue;
    }

    throw new Error(`unknown argument: ${arg}`);
  }

  return result;
};

const printUsage = (): void => {
  process.stdout.write(
    [
      "Usage: bakudo-worker --input-b64 <base64-json> [--execution-profile-b64 <base64-json>]",
      "                     [--shell bash] [--timeout-seconds N]",
      "                     [--max-output-bytes N] [--heartbeat-ms N] [--kill-grace-ms N]",
      "       bakudo-worker --capabilities",
      "",
      "Required input fields: schemaVersion plus either AttemptSpec v3 or legacy TaskRequest v1",
    ].join("\n") + "\n",
  );
};

export const runWorkerCli = async (argv: string[]): Promise<number> => {
  const args = parseWorkerArgs(argv);
  if (args.help) {
    printUsage();
    return 0;
  }

  if (args.capabilities) {
    // Phase 6 W3: emit capability JSON the host's `probeWorkerCapabilities`
    // can validate. Single-line so callers can parse stdout directly.
    process.stdout.write(`${JSON.stringify(workerSelfCapabilities())}\n`);
    return 0;
  }

  if (args.inputB64.length === 0) {
    throw new Error("missing required argument --input-b64");
  }

  const spec = decodeWorkerInput(args.inputB64);
  const executionProfile =
    args.executionProfileB64 === undefined
      ? undefined
      : decodeExecutionProfile(args.executionProfileB64);

  const result = await runWorkerTask(spec, {
    shell: args.shell,
    timeoutSeconds: args.timeoutSeconds,
    maxOutputBytes: args.maxOutputBytes,
    heartbeatIntervalMs: args.heartbeatIntervalMs,
    killGraceMs: args.killGraceMs,
    ...(executionProfile === undefined ? {} : { executionProfile }),
    emit: (event) => {
      process.stdout.write(`${serializeWorkerEvent(event)}\n`);
    },
  });

  process.stdout.write(`${serializeWorkerResult(result)}\n`);
  return result.status === "succeeded" ? 0 : 1;
};

const printWorkerError = (message: string, details?: Record<string, unknown>): void => {
  process.stdout.write(`${serializeWorkerError(message, details)}\n`);
};

if (isMainModule(import.meta.url, process.argv[1])) {
  runWorkerCli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      printWorkerError("worker_cli_failed", { message });
      process.exitCode = 2;
    });
}
