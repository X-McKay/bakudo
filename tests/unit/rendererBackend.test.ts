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

test("TtyBackend.render: writes \\x1Bc clear then transcript-frame lines", () => {
  const stdout = captureStdout(true);
  const backend = new TtyBackend(stdout);
  const frame = buildFrame();

  backend.render(frame);

  assert.equal(stdout.chunks[0], "\x1Bc", "first chunk is the screen-clear escape");
  const body = stdout.chunks.slice(1).join("");
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

test("JsonBackend.render: writes one JSONL envelope per call with kind=frame", () => {
  const stdout = captureStdout(false);
  const backend = new JsonBackend(stdout);
  const frame = buildFrame();

  backend.render(frame);

  assert.equal(stdout.chunks.length, 1, "exactly one write per render call");
  const line = stdout.chunks[0] ?? "";
  assert.ok(line.endsWith("\n"), "envelope terminates with newline");
  const parsed = JSON.parse(line.trimEnd()) as { kind: string; frame: RenderFrame };
  assert.equal(parsed.kind, "frame", "envelope kind tag");
  assert.deepEqual(parsed.frame, frame, "envelope frame payload matches input");
});

test("JsonBackend.render: emits one envelope per call across multiple frames", () => {
  const stdout = captureStdout(false);
  const backend = new JsonBackend(stdout);
  const frame = buildFrame();

  backend.render(frame);
  backend.render(frame);
  backend.render(frame);

  assert.equal(stdout.chunks.length, 3, "one JSONL line per render call");
  for (const chunk of stdout.chunks) {
    const parsed = JSON.parse(chunk.trimEnd()) as { kind: string };
    assert.equal(parsed.kind, "frame");
  }
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
