/**
 * Phase 6 Wave 6d PR11 — W7 benchmark 1 of 3.
 *
 * Plan 06 line 456: "open shell and resume latest session".
 *
 * Stands up a temp storage root with a pre-seeded session-index + one
 * persisted session, then times the end-to-end flow of
 *   1. `listSessionSummaries` (index fast-path)
 *   2. `loadSession` of the latest entry
 *   3. `selectRenderFrame` for the resumed shell
 *
 * Runs against a synthetic sandbox — NO abox spawn. Record the median in
 * `shell.startup_ms` and emit a single JSON line via `reportBenchmark`.
 *
 * Invoke manually: `node dist/tests/benchmarks/open-shell-and-resume-latest.bench.js`.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initialHostAppState } from "../../src/host/appState.js";
import { reportBenchmark, runBenchmark } from "../../src/host/metrics/benchmarkHarness.js";
import { selectRenderFrame } from "../../src/host/renderModel.js";
import { listSessionSummaries, loadSession } from "../../src/host/timeline.js";
import {
  SESSION_INDEX_SCHEMA_VERSION,
  type SessionIndexEntry,
} from "../../src/host/sessionIndex.js";
import { writeSessionIndex } from "../../src/sessionStore.js";
import type { SessionRecord } from "../../src/sessionTypes.js";

const buildSession = (sessionId: string): SessionRecord => ({
  schemaVersion: 2,
  sessionId,
  repoRoot: "/tmp/fake-repo",
  title: `bench session ${sessionId}`,
  status: "completed",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  turns: [
    {
      turnId: "turn-1",
      prompt: "bench prompt",
      mode: "standard",
      status: "completed",
      attempts: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ],
});

const main = async (): Promise<void> => {
  const storageRoot = await mkdtemp(join(tmpdir(), "bakudo-bench-resume-"));
  try {
    // Seed one session on disk + an index entry pointing at it.
    const sessionId = "bench-session-0001";
    const session = buildSession(sessionId);
    const sessionDir = join(storageRoot, sessionId);
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, "session.json"), JSON.stringify(session), "utf8");
    const entry: SessionIndexEntry = {
      schemaVersion: SESSION_INDEX_SCHEMA_VERSION,
      sessionId,
      title: session.title,
      repoRoot: session.repoRoot,
      status: session.status,
      lastMode: "standard",
      updatedAt: session.updatedAt,
    };
    await writeSessionIndex(storageRoot, [entry]);

    const state = initialHostAppState();
    const result = await runBenchmark({
      name: "open-shell-and-resume-latest",
      metric: "shell.startup_ms",
      warmup: 3,
      samples: 10,
      run: async () => {
        const summaries = await listSessionSummaries(storageRoot);
        const latest = summaries[0];
        if (latest !== undefined) {
          const resumed = await loadSession(storageRoot, latest.sessionId);
          if (resumed === null) throw new Error("failed to resume latest session");
        }
        selectRenderFrame({ state, transcript: [] });
      },
    });
    reportBenchmark(result);
  } finally {
    await rm(storageRoot, { recursive: true, force: true });
  }
};

void main().catch((err: unknown) => {
  const proc = (
    globalThis as unknown as {
      process?: { stderr?: { write: (s: string) => void }; exit?: (code: number) => void };
    }
  ).process;
  proc?.stderr?.write(`bench error: ${String(err)}\n`);
  proc?.exit?.(1);
});
