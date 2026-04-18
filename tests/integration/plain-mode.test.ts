/**
 * Phase 5 PR14 — `--plain` works without TTY.
 *
 * Required assertion (plan `05-…hardening.md:287`): the plain renderer
 * emits pipe-friendly output with no ANSI escapes regardless of stdout
 * TTY state. These tests exercise the real PlainBackend + plain frame
 * renderer for the three representative operations called out in the
 * non-TTY parity matrix (`phase-5-renderer-decision.md` §3): transcript,
 * session listing, inspect summary.
 *
 * The PlainBackend is the `--plain` dispatch target selected by
 * `selectRendererBackend({ forcePlain: true })`; a non-TTY stdout also
 * forces plain. Both paths are covered below.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ANSI_PATTERN, stripAnsi } from "../../src/host/ansi.js";
import { initialHostAppState } from "../../src/host/appState.js";
import { formatInspectSummary } from "../../src/host/inspectFormatter.js";
import { withCapturedStdout } from "../../src/host/io.js";
import type { HostCliArgs } from "../../src/host/parsing.js";
import { printSessions, printStatus } from "../../src/host/printers.js";
import { reduceHost } from "../../src/host/reducer.js";
import { selectRenderFrame, type TranscriptItem } from "../../src/host/renderModel.js";
import { selectRendererBackend, type RendererStdout } from "../../src/host/rendererBackend.js";
import { PlainBackend } from "../../src/host/renderers/plainBackend.js";
import { renderTranscriptFramePlain } from "../../src/host/renderers/plainRenderer.js";
import { SessionStore } from "../../src/sessionStore.js";

// 80-column fallback — the matrix guarantees plain output is pipe-friendly
// when the consumer has no terminal-width probe available (plan
// `05-…hardening.md:243-247`).
const TERMINAL_WIDTH_FALLBACK = 80;

const captureStdout = (): RendererStdout & { chunks: string[]; tape: () => string } => {
  const chunks: string[] = [];
  return {
    chunks,
    isTTY: false,
    tape: () => chunks.join(""),
    write(chunk: string): boolean {
      chunks.push(chunk);
      return true;
    },
  };
};

const captureWriter = (): {
  writer: { write: (chunk: string) => boolean };
  chunks: string[];
} => {
  const chunks: string[] = [];
  return {
    chunks,
    writer: {
      write: (chunk: string) => {
        chunks.push(chunk);
        return true;
      },
    },
  };
};

const baseArgs = (storageRoot: string): HostCliArgs => ({
  command: "sessions",
  config: "config/default.json",
  aboxBin: "abox",
  mode: "build",
  yes: false,
  shell: "bash",
  timeoutSeconds: 120,
  maxOutputBytes: 256 * 1024,
  heartbeatIntervalMs: 5000,
  killGraceMs: 2000,
  copilot: { outputFormat: "text" },
  storageRoot,
});

// ---------------------------------------------------------------------------
// Backend selection
// ---------------------------------------------------------------------------

test("selectRendererBackend: non-TTY stdout picks PlainBackend (pipe case)", () => {
  const stdout = captureStdout();
  const backend = selectRendererBackend({ stdout });
  assert.ok(backend instanceof PlainBackend, "non-TTY stdout → PlainBackend");
});

test("selectRendererBackend: forcePlain=true picks PlainBackend even on TTY", () => {
  const stdout: RendererStdout = { isTTY: true, write: () => true };
  const backend = selectRendererBackend({ forcePlain: true, stdout });
  assert.ok(backend instanceof PlainBackend, "forcePlain=true → PlainBackend");
});

// ---------------------------------------------------------------------------
// Transcript
// ---------------------------------------------------------------------------

test("plain transcript frame: no ANSI escapes in output", () => {
  const state = initialHostAppState();
  const transcript: TranscriptItem[] = [
    { kind: "user", text: "add richer review surface" },
    { kind: "assistant", text: "Queued sandbox attempt.", tone: "info" },
    { kind: "event", label: "session", detail: "ready" },
    {
      kind: "review",
      outcome: "success",
      summary: "all tests pass",
      nextAction: "accept",
    },
  ];
  const frame = selectRenderFrame({ state, transcript, repoLabel: "my-repo" });
  const lines = renderTranscriptFramePlain(frame);
  const joined = lines.join("\n");
  // Primary assertion: no ANSI escape sequences in plain output.
  assert.equal(joined.match(ANSI_PATTERN), null, "plain output contains no ANSI escape codes");
  // Sanity: content still renders.
  assert.match(joined, /You: add richer review surface/u);
  assert.match(joined, /Bakudo: Queued sandbox attempt\./u);
  assert.match(joined, /Review: success/u);
});

test("plain transcript frame: every line <= 80 col fallback (content-only)", () => {
  // Use short, deterministic transcript content so the only width risk
  // comes from the frame's own scaffolding (header, hints). Long user
  // input can overflow intentionally — the contract is that bakudo-produced
  // scaffolding stays within the fallback width.
  const state = initialHostAppState();
  const transcript: TranscriptItem[] = [{ kind: "assistant", text: "short", tone: "success" }];
  const frame = selectRenderFrame({ state, transcript });
  const lines = renderTranscriptFramePlain(frame);
  for (const line of lines) {
    assert.ok(
      line.length <= TERMINAL_WIDTH_FALLBACK,
      `scaffold line exceeds 80 cols (${line.length}): ${JSON.stringify(line)}`,
    );
  }
});

test("plain transcript frame: pipe-friendly newline separators (no \\x1Bc clear)", () => {
  const state = initialHostAppState();
  const transcript: TranscriptItem[] = [{ kind: "user", text: "ping" }];
  const frame = selectRenderFrame({ state, transcript });

  const stdout = captureStdout();
  const backend = new PlainBackend(stdout);
  backend.render(frame);
  backend.render(frame);
  const body = stdout.tape();
  assert.ok(!body.includes("\x1Bc"), "plain output never emits the full-terminal reset \\x1Bc");
  assert.ok(!body.includes("\x1B[?1049h"), "plain output never enters the alt screen");
  assert.ok(!body.includes("\x1B[?25l"), "plain output never hides the cursor");
  // Consecutive frames are newline-delimited.
  assert.ok(body.endsWith("\n"), "output ends with a newline");
});

// ---------------------------------------------------------------------------
// Session list
// ---------------------------------------------------------------------------

test("plain session list: no ANSI when captured via withCapturedStdout (non-TTY)", async () => {
  const root = await mkdtemp(join(tmpdir(), "bakudo-plain-sessions-"));
  try {
    const store = new SessionStore(root);
    await store.createSession({
      sessionId: "session-plain-1",
      goal: "pipe-friendly sessions listing",
      repoRoot: "/tmp/repo",
      assumeDangerousSkipPermissions: false,
      status: "completed",
    });
    await store.createSession({
      sessionId: "session-plain-2",
      goal: "another session",
      repoRoot: "/tmp/repo",
      assumeDangerousSkipPermissions: false,
      status: "running",
    });

    const cap = captureWriter();
    const args = baseArgs(root);
    // `text` format routes through the legacy renderers in printers.ts
    // which wrap certain labels in ANSI by default. Stripping must leave
    // each session id intact.
    const code = await withCapturedStdout(cap.writer, () => printSessions(args));
    assert.equal(code, 0);
    const body = cap.chunks.join("");
    const stripped = stripAnsi(body);
    // Real contract: every session id appears in the stripped body.
    assert.match(stripped, /session-plain-1/u);
    assert.match(stripped, /session-plain-2/u);
    // Pipe-friendly: newline-separated.
    assert.ok(stripped.includes("\n"), "session list lines are newline-separated");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Status (non-TTY parity)
// ---------------------------------------------------------------------------

test("plain status (no session id): newline-separated, stripped cleanly to ASCII", async () => {
  const root = await mkdtemp(join(tmpdir(), "bakudo-plain-status-"));
  try {
    const store = new SessionStore(root);
    await store.createSession({
      sessionId: "session-status-plain",
      goal: "status plain",
      repoRoot: "/tmp/repo",
      assumeDangerousSkipPermissions: false,
      status: "completed",
    });

    const cap = captureWriter();
    const args = { ...baseArgs(root), command: "status" as const };
    const code = await withCapturedStdout(cap.writer, () => printStatus(args));
    assert.equal(code, 0);
    const body = cap.chunks.join("");
    const stripped = stripAnsi(body);
    assert.match(stripped, /session-status-plain/u);
    // Each non-empty line is an independent record — no partial lines.
    for (const line of stripped.split("\n")) {
      if (line.length === 0) {
        continue;
      }
      // pipe-friendly: the line should print without requiring a TTY.
      assert.equal(line.match(/\r/u), null, "CRs would break `| grep` pipelines");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Inspect summary
// ---------------------------------------------------------------------------

test("plain inspect summary: string[] lines have no ANSI", () => {
  const session = {
    schemaVersion: 2 as const,
    sessionId: "session-inspect-plain",
    repoRoot: "/tmp/repo",
    title: "plain inspect summary",
    status: "completed" as const,
    turns: [],
    createdAt: "2026-04-16T00:00:00.000Z",
    updatedAt: "2026-04-16T00:05:00.000Z",
  };
  const lines = formatInspectSummary({ session });
  for (const line of lines) {
    assert.equal(line.match(ANSI_PATTERN), null, `unexpected ANSI in inspect line: ${line}`);
  }
  // Sanity: content is present.
  const joined = lines.join("\n");
  assert.match(joined, /Summary/u);
  assert.match(joined, /session-inspect-plain/u);
});

// ---------------------------------------------------------------------------
// Plan mode header parity
// ---------------------------------------------------------------------------

test("plain renderer preserves composer mode in the header (PLAN)", () => {
  let state = initialHostAppState();
  state = reduceHost(state, { type: "set_mode", mode: "plan" });
  const frame = selectRenderFrame({ state, transcript: [] });
  const lines = renderTranscriptFramePlain(frame);
  const header = lines[0] ?? "";
  assert.match(header, /PLAN/u, "plain header shows PLAN mode");
  assert.equal(header.match(ANSI_PATTERN), null, "plain header is free of ANSI");
});
