import assert from "node:assert/strict";
import test from "node:test";

import { initialHostAppState } from "../../src/host/appState.js";
import { selectRenderFrame, type RenderFrame } from "../../src/host/renderModel.js";
import type { RendererStdout } from "../../src/host/rendererBackend.js";
import {
  CLEAR_TARGETED,
  ENTER_ALT_SCREEN,
  EXIT_ALT_SCREEN,
  HIDE_CURSOR,
  SHOW_CURSOR,
  TtyBackend,
  type TtyBackendStdin,
} from "../../src/host/renderers/ttyBackend.js";

const captureStdout = (): RendererStdout & { chunks: string[] } => {
  const chunks: string[] = [];
  return {
    chunks,
    isTTY: true,
    write(chunk: string): boolean {
      chunks.push(chunk);
      return true;
    },
  };
};

const buildFrame = (): RenderFrame =>
  selectRenderFrame({
    state: initialHostAppState(),
    transcript: [{ kind: "user", text: "hi" }],
    repoLabel: "r",
  });

test("TtyBackend: first render enters alt-screen + hides cursor (in that order)", () => {
  const stdout = captureStdout();
  const backend = new TtyBackend(stdout, { env: {} });
  backend.render(buildFrame());

  assert.equal(stdout.chunks[0], ENTER_ALT_SCREEN, "first write is enter-alt-screen");
  assert.equal(stdout.chunks[1], HIDE_CURSOR, "second write is hide-cursor");
  // Then targeted clear, then body.
  assert.equal(stdout.chunks[2], CLEAR_TARGETED, "third write is targeted clear");
  assert.ok(stdout.chunks.length >= 4, "has body write after clear");
});

test("TtyBackend: second render does NOT re-enter alt-screen", () => {
  const stdout = captureStdout();
  const backend = new TtyBackend(stdout, { env: {} });
  backend.render(buildFrame());
  const lenAfterFirst = stdout.chunks.length;

  backend.render(buildFrame());

  // New writes on the second tick: targeted clear + body only.
  const newChunks = stdout.chunks.slice(lenAfterFirst);
  assert.ok(!newChunks.includes(ENTER_ALT_SCREEN), "second render must not re-enter alt-screen");
  assert.ok(!newChunks.includes(HIDE_CURSOR), "second render must not re-hide cursor");
  assert.equal(newChunks[0], CLEAR_TARGETED, "second render starts with clear");
});

test("TtyBackend: dispose() emits exit-alt-screen + show-cursor", () => {
  const stdout = captureStdout();
  const backend = new TtyBackend(stdout, { env: {} });
  backend.render(buildFrame());
  const lenBefore = stdout.chunks.length;

  backend.dispose();

  const disposeChunks = stdout.chunks.slice(lenBefore);
  assert.ok(disposeChunks.includes(SHOW_CURSOR), "dispose writes show-cursor");
  assert.ok(disposeChunks.includes(EXIT_ALT_SCREEN), "dispose writes exit-alt-screen");
  // Show-cursor should precede exit-alt-screen so the cursor is visible when
  // the user's pre-invocation terminal state is restored.
  const showIdx = disposeChunks.indexOf(SHOW_CURSOR);
  const exitIdx = disposeChunks.indexOf(EXIT_ALT_SCREEN);
  assert.ok(showIdx < exitIdx, "show-cursor precedes exit-alt-screen");
});

test("TtyBackend: dispose() is idempotent", () => {
  const stdout = captureStdout();
  const backend = new TtyBackend(stdout, { env: {} });
  backend.render(buildFrame());
  backend.dispose();
  const lenAfterFirst = stdout.chunks.length;

  backend.dispose();
  backend.dispose();

  assert.equal(stdout.chunks.length, lenAfterFirst, "subsequent dispose() calls write nothing");
  assert.ok(backend.isDisposed(), "backend reports disposed state");
});

test("TtyBackend: dispose() without prior render writes nothing (no enter ⇒ no exit)", () => {
  const stdout = captureStdout();
  const backend = new TtyBackend(stdout, { env: {} });

  backend.dispose();

  assert.equal(stdout.chunks.length, 0, "dispose before any render must not emit exit sequences");
  assert.ok(backend.isDisposed(), "still marked disposed");
});

test("TtyBackend: BAKUDO_NO_ALT_SCREEN=1 skips alt-screen but still renders", () => {
  const stdout = captureStdout();
  const backend = new TtyBackend(stdout, { env: { BAKUDO_NO_ALT_SCREEN: "1" } });
  backend.render(buildFrame());

  assert.ok(!stdout.chunks.includes(ENTER_ALT_SCREEN), "opt-out must not enter alt-screen");
  // Cursor is still hidden during rendering (parity with Copilot v1.0.24).
  assert.equal(stdout.chunks[0], HIDE_CURSOR, "still hides cursor on render");
  assert.equal(stdout.chunks[1], CLEAR_TARGETED, "still clears before body");
  assert.ok(stdout.chunks.length >= 3, "body write is present");
});

test("TtyBackend: opt-out dispose restores cursor but does not exit alt-screen", () => {
  const stdout = captureStdout();
  const backend = new TtyBackend(stdout, { env: { BAKUDO_NO_ALT_SCREEN: "1" } });
  backend.render(buildFrame());
  const lenBefore = stdout.chunks.length;

  backend.dispose();

  const disposeChunks = stdout.chunks.slice(lenBefore);
  assert.ok(disposeChunks.includes(SHOW_CURSOR), "shows cursor on dispose");
  assert.ok(!disposeChunks.includes(EXIT_ALT_SCREEN), "no exit-alt-screen when opt-out is active");
});

test("TtyBackend: render uses \\x1B[H\\x1B[2J (not \\x1Bc) for per-tick clear", () => {
  const stdout = captureStdout();
  const backend = new TtyBackend(stdout, { env: {} });
  backend.render(buildFrame());
  backend.render(buildFrame());

  assert.ok(
    !stdout.chunks.some((c) => c === "\x1Bc"),
    "the old full-reset \\x1Bc must not be used",
  );
  const clears = stdout.chunks.filter((c) => c === CLEAR_TARGETED);
  assert.equal(clears.length, 2, "one targeted clear per render tick");
});

test("TtyBackend: with TTY stdin enables raw mode on enter and restores on dispose", () => {
  const stdout = captureStdout();
  const rawCalls: boolean[] = [];
  const stdin: TtyBackendStdin = {
    isTTY: true,
    isRaw: false,
    setRawMode: (enabled: boolean) => {
      rawCalls.push(enabled);
      return undefined;
    },
  };
  const backend = new TtyBackend(stdout, { env: {}, stdin });
  backend.render(buildFrame());
  backend.dispose();

  assert.deepEqual(
    rawCalls,
    [true, false],
    "setRawMode(true) on enter, setRawMode(false) on dispose",
  );
});

test("TtyBackend: non-TTY stdin does NOT toggle raw mode", () => {
  const stdout = captureStdout();
  let called = false;
  const stdin: TtyBackendStdin = {
    isTTY: false,
    setRawMode: () => {
      called = true;
      return undefined;
    },
  };
  const backend = new TtyBackend(stdout, { env: {}, stdin });
  backend.render(buildFrame());
  backend.dispose();

  assert.equal(called, false, "non-TTY stdin must not have setRawMode invoked");
});

test("TtyBackend: render after dispose falls back to plain write (no ANSI)", () => {
  const stdout = captureStdout();
  const backend = new TtyBackend(stdout, { env: {} });
  backend.render(buildFrame());
  backend.dispose();
  const lenBefore = stdout.chunks.length;

  backend.render(buildFrame());

  const afterChunks = stdout.chunks.slice(lenBefore);
  // Should only contain the body (no enter/clear).
  assert.ok(
    !afterChunks.includes(ENTER_ALT_SCREEN),
    "post-dispose render must not re-enter alt-screen",
  );
  assert.ok(
    !afterChunks.includes(CLEAR_TARGETED),
    "post-dispose render must not emit targeted clear",
  );
  assert.equal(afterChunks.length, 1, "exactly one plain body write");
});

test("TtyBackend: hasEntered() reflects first-render transition", () => {
  const stdout = captureStdout();
  const backend = new TtyBackend(stdout, { env: {} });
  assert.equal(backend.hasEntered(), false, "not entered before any render");
  backend.render(buildFrame());
  assert.equal(backend.hasEntered(), true, "entered after first render");
});
