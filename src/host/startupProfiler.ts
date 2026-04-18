import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

type PerfLike = { now(): number };

const perfSource = (): PerfLike => {
  const candidate = (globalThis as { performance?: PerfLike }).performance;
  if (candidate && typeof candidate.now === "function") {
    return candidate;
  }
  const started = Date.now();
  return { now: () => Date.now() - started };
};

const perf = perfSource();
const processStart = perf.now();

export type StartupCheckpoint = { name: string; ms: number };

const checkpoints: StartupCheckpoint[] = [];

/**
 * Record a named startup checkpoint relative to module load. Checkpoints are
 * retained in-process and flushed by {@link profileReport} when enabled.
 */
export const profileCheckpoint = (name: string): void => {
  checkpoints.push({ name, ms: perf.now() - processStart });
};

/** Return a copy of the recorded checkpoints (test hook). */
export const profileSnapshot = (): StartupCheckpoint[] => checkpoints.slice();

/** Clear the recorded checkpoints (test hook). */
export const resetProfile = (): void => {
  checkpoints.length = 0;
};

const profileEnvEnabled = (): boolean => {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env;
  return env?.BAKUDO_PROFILE === "1";
};

const readPid = (): string => {
  const proc = (globalThis as { process?: { pid?: number } }).process;
  return proc?.pid !== undefined ? String(proc.pid) : "0";
};

/**
 * Flush the recorded checkpoints to `.bakudo/log/startup-<pid>-<iso>.json` iff
 * `BAKUDO_PROFILE=1` is set in the environment. Any write error is swallowed
 * — profiling must never crash the shell.
 */
export const profileReport = async (baseDir = "."): Promise<void> => {
  if (!profileEnvEnabled()) {
    return;
  }
  try {
    const logDir = join(resolve(baseDir), ".bakudo", "log");
    await mkdir(logDir, { recursive: true });
    const iso = new Date().toISOString().replace(/[:.]/g, "-");
    const target = join(logDir, `startup-${readPid()}-${iso}.json`);
    const payload = {
      pid: readPid(),
      startedAt: new Date(Date.now() - (perf.now() - processStart)).toISOString(),
      totalMs: perf.now() - processStart,
      checkpoints: profileSnapshot(),
    };
    await writeFile(target, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  } catch {
    // swallow — profiling must never crash the shell
  }
};
