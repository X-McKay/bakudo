/**
 * Phase 6 Wave 6d PR11 — W7 benchmark 3 of 3.
 *
 * Plan 06 line 458: "retry a failed turn and inspect lineage".
 *
 * Seeds a session with a failed parent turn + a retry turn referencing it via
 * `parentTurnId`. Measures:
 *   1. Re-parsing the retry-submission command (prompt→host-line cost).
 *   2. Resolving attempt lineage from the persisted data (the inspect surface
 *      Phase 4 W4 landed in `attemptLineage.ts`).
 *
 * Stubs the worker — no abox spawn. Records `prompt.to_host_line_ms` and
 * `render.ttfr_ms` as the load-bearing segments.
 *
 * Invoke manually:
 *   `node dist/tests/benchmarks/retry-failed-turn-and-inspect-lineage.bench.js`.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { reportBenchmark, runBenchmark } from "../../src/host/metrics/benchmarkHarness.js";
import { formatInspectSummary } from "../../src/host/inspectFormatter.js";
import { parseHostArgs, tokenizeCommand } from "../../src/host/parsing.js";
import { loadSession } from "../../src/host/timeline.js";
import type { SessionRecord } from "../../src/sessionTypes.js";

const buildSessionWithLineage = (sessionId: string): SessionRecord => ({
  schemaVersion: 2,
  sessionId,
  repoRoot: "/tmp/fake-repo",
  title: "retry lineage bench",
  status: "failed",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  turns: [
    {
      turnId: "turn-1",
      prompt: "initial failing build",
      mode: "standard",
      status: "failed",
      attempts: [],
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      updatedAt: new Date(Date.now() - 30_000).toISOString(),
    },
    {
      turnId: "turn-2",
      prompt: "retry: initial failing build",
      mode: "standard",
      status: "completed",
      attempts: [],
      createdAt: new Date(Date.now() - 20_000).toISOString(),
      updatedAt: new Date().toISOString(),
      parentTurnId: "turn-1",
    },
  ],
});

const main = async (): Promise<void> => {
  const storageRoot = await mkdtemp(join(tmpdir(), "bakudo-bench-retry-"));
  try {
    const sessionId = "bench-retry-0001";
    const session = buildSessionWithLineage(sessionId);
    const sessionDir = join(storageRoot, sessionId);
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, "session.json"), JSON.stringify(session), "utf8");

    const submitResult = await runBenchmark({
      name: "retry-submission",
      metric: "prompt.to_host_line_ms",
      warmup: 3,
      samples: 10,
      run: () => {
        const argv = tokenizeCommand(
          "build --session-id bench-retry-0001 'retry: initial failing build'",
        );
        parseHostArgs(argv);
      },
    });
    reportBenchmark(submitResult);

    const lineageResult = await runBenchmark({
      name: "inspect-retry-lineage",
      metric: "render.ttfr_ms",
      warmup: 3,
      samples: 10,
      run: async () => {
        const persisted = await loadSession(storageRoot, sessionId);
        if (persisted === null) throw new Error("failed to load persisted session");
        // Inspect renders the latest turn; lineage navigates via parentTurnId.
        const latest = persisted.turns.at(-1);
        formatInspectSummary(
          latest === undefined ? { session: persisted } : { session: persisted, turn: latest },
        );
      },
    });
    reportBenchmark(lineageResult);
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
