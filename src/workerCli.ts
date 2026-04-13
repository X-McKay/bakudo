#!/usr/bin/env node

import {
  parseWorkerTaskSpec,
  runWorkerTask,
  serializeWorkerError,
  serializeWorkerEvent,
  serializeWorkerResult,
} from "./workerRuntime.js";

export type WorkerCliArgs = {
  taskSpecB64: string;
  shell: string;
  timeoutSeconds: number;
  maxOutputBytes: number;
  heartbeatIntervalMs: number;
  killGraceMs: number;
  help: boolean;
};

const parsePositiveInteger = (value: string | undefined, fallback: number, name: string): number => {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`invalid ${name}: expected positive integer`);
  }

  return parsed;
};

const readLongFlag = (argv: string[], index: number, flag: string): { value: string; consumed: number } => {
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
    taskSpecB64: "",
    shell: "bash",
    timeoutSeconds: 120,
    maxOutputBytes: 256 * 1024,
    heartbeatIntervalMs: 5000,
    killGraceMs: 2000,
    help: false,
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

    if (arg === "--task-spec-b64" || arg.startsWith("--task-spec-b64=")) {
      const { value, consumed } = readLongFlag(argv, i, "--task-spec-b64");
      result.taskSpecB64 = value;
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
      result.timeoutSeconds = parsePositiveInteger(value, result.timeoutSeconds, "--timeout-seconds");
      i += consumed - 1;
      continue;
    }

    if (arg === "--max-output-bytes" || arg.startsWith("--max-output-bytes=")) {
      const { value, consumed } = readLongFlag(argv, i, "--max-output-bytes");
      result.maxOutputBytes = parsePositiveInteger(value, result.maxOutputBytes, "--max-output-bytes");
      i += consumed - 1;
      continue;
    }

    if (arg === "--heartbeat-ms" || arg.startsWith("--heartbeat-ms=")) {
      const { value, consumed } = readLongFlag(argv, i, "--heartbeat-ms");
      result.heartbeatIntervalMs = parsePositiveInteger(value, result.heartbeatIntervalMs, "--heartbeat-ms");
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
      "Usage: bakudo-worker --task-spec-b64 <base64-json> [--shell bash] [--timeout-seconds N]",
      "                     [--max-output-bytes N] [--heartbeat-ms N] [--kill-grace-ms N]",
      "",
      "Required task spec fields: schemaVersion, taskId, sessionId, goal, assumeDangerousSkipPermissions",
    ].join("\n") + "\n",
  );
};

export const runWorkerCli = async (argv: string[]): Promise<number> => {
  const args = parseWorkerArgs(argv);
  if (args.help) {
    printUsage();
    return 0;
  }

  if (args.taskSpecB64.length === 0) {
    throw new Error("missing required argument --task-spec-b64");
  }

  const spec = parseWorkerTaskSpec(["--task-spec-b64", args.taskSpecB64]);

  const result = await runWorkerTask(spec, {
    shell: args.shell,
    timeoutSeconds: args.timeoutSeconds,
    maxOutputBytes: args.maxOutputBytes,
    heartbeatIntervalMs: args.heartbeatIntervalMs,
    killGraceMs: args.killGraceMs,
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

if (import.meta.url === `file://${process.argv[1]}`) {
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
