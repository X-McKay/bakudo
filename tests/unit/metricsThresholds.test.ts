/**
 * Phase 6 Wave 6d PR11 — W7 threshold tests.
 *
 * Plan 06 §Workstream 7 "Suggested Thresholds" (lines 443-448):
 *   1. TTFR < 200ms on a warm local run
 *   2. Prompt submit → first semantic host line < 250ms (before dispatch)
 *   3. Session list with 500 sessions from index < 100ms
 *   4. Inspect summary render from persisted data < 150ms
 *
 * Each threshold gets a 1:1 test. Every test:
 *   - Runs a short warmup (to stabilise JIT/cache state).
 *   - Takes the median of 10 measured samples as the comparison point.
 *   - Asserts the median is under the plan-stated ceiling.
 *
 * These tests intentionally stay within the default `node --test` timeout
 * — each threshold has a `{ timeout: 30_000 }` override as a safety net.
 *
 * Thresholds are treated as SLOs, not hard caps: if a test is slow on a
 * specific CI runner, adjust the guidance in the plan rather than silently
 * forcing the test to pass.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { listSessionSummaries } from "../../src/host/timeline.js";
import { formatInspectSummary } from "../../src/host/inspectFormatter.js";
import {
  SESSION_INDEX_SCHEMA_VERSION,
  type SessionIndexEntry,
} from "../../src/host/sessionIndex.js";
import { writeSessionIndex } from "../../src/sessionStore.js";
import { runBenchmark } from "../../src/host/metrics/benchmarkHarness.js";
import type { SessionRecord } from "../../src/sessionTypes.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const withTempDir = async (fn: (dir: string) => Promise<void>): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), "bakudo-metrics-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

/** Synthesize 500 session index entries for the session-list threshold. */
const synthesizeIndexEntries = (count: number): SessionIndexEntry[] => {
  const base = Date.now();
  const entries: SessionIndexEntry[] = [];
  for (let i = 0; i < count; i += 1) {
    entries.push({
      schemaVersion: SESSION_INDEX_SCHEMA_VERSION,
      sessionId: `session-${String(i).padStart(4, "0")}`,
      title: `synthetic session ${i}`,
      repoRoot: `/tmp/fake-repo-${i}`,
      status: "completed",
      lastMode: "standard",
      updatedAt: new Date(base - i * 1000).toISOString(),
    });
  }
  return entries;
};

// ---------------------------------------------------------------------------
// Threshold 1: TTFR < 200ms (plan line 447)
// ---------------------------------------------------------------------------

test(
  "threshold: time-to-first-render < 200ms on a warm local run",
  { timeout: 30_000 },
  async () => {
    // TTFR is the time from render-loop start to first paint. We approximate
    // "first paint" with the cost of building the initial frame model + the
    // synchronous write into a capture sink. The production renderer uses
    // `selectRenderFrame` (pure) + the renderer backend's `write`; measuring
    // the pure frame build is the load-bearing segment.
    const { selectRenderFrame } = await import("../../src/host/renderModel.js");
    const { initialHostAppState } = await import("../../src/host/appState.js");
    const state = initialHostAppState();
    const result = await runBenchmark({
      name: "ttfr-warm",
      metric: "render.ttfr_ms",
      warmup: 5,
      samples: 10,
      run: () => {
        selectRenderFrame({ state, transcript: [] });
      },
    });
    assert.ok(
      result.median < 200,
      `median TTFR ${result.median.toFixed(2)}ms exceeds 200ms threshold — warmup p95=${result.p95.toFixed(2)}ms`,
    );
  },
);

// ---------------------------------------------------------------------------
// Threshold 2: prompt submit → first semantic host line < 250ms (plan line 448)
// ---------------------------------------------------------------------------

test(
  "threshold: prompt-submit → first-host-line < 250ms (before dispatch)",
  { timeout: 30_000 },
  async () => {
    // Model the pre-dispatch pipeline: `parseHostArgs` + `tokenizeCommand` +
    // `deriveShellContext` + mutating the transcript with the first semantic
    // host line. These are the sync steps between prompt submit and the
    // first on-screen host-emitted line.
    const { parseHostArgs, tokenizeCommand } = await import("../../src/host/parsing.js");
    const { deriveShellContext } = await import("../../src/host/interactiveRenderLoop.js");
    const { initialHostAppState } = await import("../../src/host/appState.js");
    const result = await runBenchmark({
      name: "prompt-to-host-line",
      metric: "prompt.to_host_line_ms",
      warmup: 5,
      samples: 10,
      run: () => {
        const argv = tokenizeCommand("build 'do the thing'");
        parseHostArgs(argv);
        deriveShellContext(initialHostAppState());
      },
    });
    assert.ok(
      result.median < 250,
      `median prompt→host-line ${result.median.toFixed(2)}ms exceeds 250ms threshold — p95=${result.p95.toFixed(2)}ms`,
    );
  },
);

// ---------------------------------------------------------------------------
// Threshold 3: session list with 500 sessions from index < 100ms (plan line 449)
// ---------------------------------------------------------------------------

test(
  "threshold: session-list with 500 sessions from index < 100ms",
  { timeout: 30_000 },
  async () => {
    await withTempDir(async (storageRoot) => {
      // Write a real index file with 500 entries and measure
      // `listSessionSummaries`. Creating 500 session-dirs is overkill — the
      // production fast path reads the index directly.
      await mkdir(storageRoot, { recursive: true });
      const entries = synthesizeIndexEntries(500);
      await writeSessionIndex(storageRoot, entries);
      const result = await runBenchmark({
        name: "session-list-500",
        metric: "session.list_ms",
        warmup: 3,
        samples: 10,
        run: async () => {
          const listed = await listSessionSummaries(storageRoot);
          assert.equal(listed.length, 500);
        },
      });
      assert.ok(
        result.median < 100,
        `median session-list ${result.median.toFixed(2)}ms exceeds 100ms threshold — p95=${result.p95.toFixed(2)}ms`,
      );
    });
  },
);

// ---------------------------------------------------------------------------
// Threshold 4: inspect summary render from persisted data < 150ms (plan line 450)
// ---------------------------------------------------------------------------

const buildSyntheticSession = (): SessionRecord => ({
  schemaVersion: 2,
  sessionId: "synthetic-session",
  repoRoot: "/tmp/fake-repo",
  title: "synthetic inspect summary",
  status: "completed",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  turns: [
    {
      turnId: "turn-1",
      prompt: "synthetic prompt for inspect",
      mode: "standard",
      status: "completed",
      attempts: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ],
});

test(
  "threshold: inspect-summary render from persisted data < 150ms",
  { timeout: 30_000 },
  async () => {
    await withTempDir(async (storageRoot) => {
      const session = buildSyntheticSession();
      // Persist the session to disk so we measure the "from persisted data"
      // load-bearing path: read session.json + run the formatter.
      const sessionDir = join(storageRoot, session.sessionId);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(sessionDir, "session.json"), JSON.stringify(session), "utf8");

      const { loadSession } = await import("../../src/host/timeline.js");
      const result = await runBenchmark({
        name: "inspect-summary",
        metric: "render.ttfr_ms",
        warmup: 3,
        samples: 10,
        run: async () => {
          const persisted = await loadSession(storageRoot, session.sessionId);
          assert.ok(persisted !== null);
          const lines = formatInspectSummary({ session: persisted });
          assert.ok(lines.length >= 4);
        },
      });
      assert.ok(
        result.median < 150,
        `median inspect-summary ${result.median.toFixed(2)}ms exceeds 150ms threshold — p95=${result.p95.toFixed(2)}ms`,
      );
    });
  },
);
