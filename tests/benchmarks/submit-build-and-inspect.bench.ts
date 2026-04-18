/**
 * Phase 6 Wave 6d PR11 — W7 benchmark 2 of 3.
 *
 * Plan 06 line 457: "submit a build prompt and inspect the result".
 *
 * Models the pre-dispatch slice (up to first semantic host line) plus the
 * inspect-summary render against a persisted session. Dispatch itself is
 * stubbed — we do not spawn abox. Records `prompt.to_host_line_ms` + the
 * inspect formatter cost.
 *
 * Invoke manually: `node dist/tests/benchmarks/submit-build-and-inspect.bench.js`.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initialHostAppState } from "../../src/host/appState.js";
import { reportBenchmark, runBenchmark } from "../../src/host/metrics/benchmarkHarness.js";
import { deriveShellContext } from "../../src/host/interactiveRenderLoop.js";
import { formatInspectSummary } from "../../src/host/inspectFormatter.js";
import { parseHostArgs, tokenizeCommand } from "../../src/host/parsing.js";
import { loadSession } from "../../src/host/timeline.js";
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
      prompt: "bench: make the widget better",
      mode: "standard",
      status: "completed",
      attempts: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ],
});

const main = async (): Promise<void> => {
  const storageRoot = await mkdtemp(join(tmpdir(), "bakudo-bench-build-"));
  try {
    const sessionId = "bench-build-0001";
    const session = buildSession(sessionId);
    const sessionDir = join(storageRoot, sessionId);
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(sessionDir, "session.json"), JSON.stringify(session), "utf8");

    const state = initialHostAppState();

    const submitResult = await runBenchmark({
      name: "submit-build-prompt",
      metric: "prompt.to_host_line_ms",
      warmup: 3,
      samples: 10,
      run: () => {
        const argv = tokenizeCommand("build 'make the widget better'");
        parseHostArgs(argv);
        deriveShellContext(state);
      },
    });
    reportBenchmark(submitResult);

    const inspectResult = await runBenchmark({
      name: "inspect-result",
      metric: "render.ttfr_ms",
      warmup: 3,
      samples: 10,
      run: async () => {
        const persisted = await loadSession(storageRoot, sessionId);
        if (persisted === null) throw new Error("failed to load persisted session");
        formatInspectSummary({ session: persisted });
      },
    });
    reportBenchmark(inspectResult);
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
