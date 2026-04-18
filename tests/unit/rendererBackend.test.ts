import assert from "node:assert/strict";
import test from "node:test";

import { stripAnsi } from "../../src/host/ansi.js";
import { initialHostAppState } from "../../src/host/appState.js";
import { selectRenderFrame, type RenderFrame } from "../../src/host/renderModel.js";
import { selectRendererBackend, type RendererStdout } from "../../src/host/rendererBackend.js";
import { JsonBackend } from "../../src/host/renderers/jsonBackend.js";
import { PlainBackend } from "../../src/host/renderers/plainBackend.js";
import { renderTranscriptFramePlain } from "../../src/host/renderers/plainRenderer.js";
import { renderTranscriptFrame } from "../../src/host/renderers/transcriptRenderer.js";
import { TtyBackend } from "../../src/host/renderers/ttyBackend.js";

const captureStdout = (isTTY: boolean): RendererStdout & { chunks: string[] } => {
  const chunks: string[] = [];
  return {
    chunks,
    isTTY,
    write(chunk: string): boolean {
      chunks.push(chunk);
      return true;
    },
  };
};

const buildFrame = (): RenderFrame =>
  selectRenderFrame({
    state: initialHostAppState(),
    transcript: [
      { kind: "user", text: "hello" },
      { kind: "assistant", text: "world", tone: "info" },
    ],
    repoLabel: "my-repo",
  });

const withNoColor = <T>(value: string | undefined, fn: () => T): T => {
  const prior = process.env.NO_COLOR;
  if (value === undefined) {
    delete process.env.NO_COLOR;
  } else {
    process.env.NO_COLOR = value;
  }
  try {
    return fn();
  } finally {
    if (prior === undefined) {
      delete process.env.NO_COLOR;
    } else {
      process.env.NO_COLOR = prior;
    }
  }
};

test("selectRendererBackend: useJson=true returns JsonBackend (even with TTY stdout)", () => {
  const stdout = captureStdout(true);
  withNoColor(undefined, () => {
    const backend = selectRendererBackend({ useJson: true, stdout });
    assert.ok(backend instanceof JsonBackend, "expected JsonBackend");
  });
});

test("selectRendererBackend: useJson=true wins over forcePlain=true", () => {
  const stdout = captureStdout(false);
  const backend = selectRendererBackend({ useJson: true, forcePlain: true, stdout });
  assert.ok(backend instanceof JsonBackend, "JSON output wins over plain when both set");
});

test("selectRendererBackend: forcePlain=true returns PlainBackend (even on TTY)", () => {
  const stdout = captureStdout(true);
  withNoColor(undefined, () => {
    const backend = selectRendererBackend({ forcePlain: true, stdout });
    assert.ok(backend instanceof PlainBackend, "expected PlainBackend");
  });
});

test("selectRendererBackend: TTY stdout (no flags) returns TtyBackend", () => {
  const stdout = captureStdout(true);
  withNoColor(undefined, () => {
    const backend = selectRendererBackend({ stdout });
    assert.ok(backend instanceof TtyBackend, "expected TtyBackend for TTY without flags");
  });
});

test("selectRendererBackend: non-TTY stdout falls back to PlainBackend (pipe case)", () => {
  const stdout = captureStdout(false);
  withNoColor(undefined, () => {
    const backend = selectRendererBackend({ stdout });
    assert.ok(backend instanceof PlainBackend, "expected PlainBackend for non-TTY stdout");
  });
});

test("selectRendererBackend: NO_COLOR forces PlainBackend even with TTY", () => {
  const stdout = captureStdout(true);
  withNoColor("1", () => {
    const backend = selectRendererBackend({ stdout });
    assert.ok(backend instanceof PlainBackend, "expected PlainBackend when NO_COLOR set");
  });
});

test("TtyBackend.render: enters alt-screen + hides cursor, then targeted clear + body", () => {
  const stdout = captureStdout(true);
  // Pass an env that explicitly leaves alt-screen enabled so the test is
  // isolated from the ambient process.env.
  const backend = new TtyBackend(stdout, { env: {} });
  const frame = buildFrame();

  backend.render(frame);

  assert.equal(stdout.chunks[0], "\x1B[?1049h", "first chunk enters alt-screen (DECSET 1049)");
  assert.equal(stdout.chunks[1], "\x1B[?25l", "second chunk hides the cursor");
  assert.equal(
    stdout.chunks[2],
    "\x1B[H\x1B[2J",
    "third chunk is the targeted cursor-home + clear-screen sequence",
  );
  const body = stdout.chunks.slice(3).join("");
  const expected = `${renderTranscriptFrame(frame).join("\n")}\n`;
  assert.equal(body, expected, "body matches renderTranscriptFrame output");
  // Sanity: body should (potentially) contain ANSI escapes, and its stripped
  // form should include "Bakudo" from the header.
  assert.ok(stripAnsi(body).includes("Bakudo"), "stripped body contains header text");
});

test("PlainBackend.render: writes transcript-frame-plain lines with trailing newline, no \\x1Bc", () => {
  const stdout = captureStdout(false);
  const backend = new PlainBackend(stdout);
  const frame = buildFrame();

  backend.render(frame);

  const body = stdout.chunks.join("");
  assert.ok(!body.includes("\x1Bc"), "plain output must not include screen-clear");
  const expected = `${renderTranscriptFramePlain(frame).join("\n")}\n`;
  assert.equal(body, expected, "body matches renderTranscriptFramePlain output");
  assert.ok(body.endsWith("\n"), "output ends with a bare newline separator");
});

test("JsonBackend.render is a no-op (PR3 moved emission to emitJsonEnvelope)", () => {
  // Phase 5 PR3 changed JsonBackend.render to be documented as a no-op.
  // Render-frame state is not meaningful to automation consumers; the real
  // emission path is `emitJsonEnvelope(envelope)` invoked by the
  // sessionController tee. See `tests/unit/jsonBackend.test.ts` for the
  // full emission-surface contract.
  const stdout = captureStdout(false);
  const backend = new JsonBackend(stdout);
  const frame = buildFrame();

  backend.render(frame);
  backend.render(frame);

  assert.equal(stdout.chunks.length, 0, "render(frame) must not write to stdout");
});

test("RendererBackend interface: all three backends are assignable to the type", () => {
  // Compile-time check materialized at runtime — instantiating each backend
  // proves the RendererBackend structural contract is satisfied.
  const stdout = captureStdout(false);
  const tty = new TtyBackend(stdout);
  const plain = new PlainBackend(stdout);
  const json = new JsonBackend(stdout);
  assert.equal(typeof tty.render, "function");
  assert.equal(typeof plain.render, "function");
  assert.equal(typeof json.render, "function");
});
