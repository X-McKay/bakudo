import assert from "node:assert/strict";
import test from "node:test";

import { initialHostAppState } from "../../src/host/appState.js";
import { reduceHost } from "../../src/host/reducer.js";
import { selectRenderFrame, type RenderFrame } from "../../src/host/renderModel.js";
import { selectRendererBackend, type RendererStdout } from "../../src/host/rendererBackend.js";
import { InkBackend } from "../../src/host/renderers/inkBackend.js";
import { JsonBackend } from "../../src/host/renderers/jsonBackend.js";
import { PlainBackend } from "../../src/host/renderers/plainBackend.js";
import { renderTranscriptFramePlain } from "../../src/host/renderers/plainRenderer.js";
import { createHostStore } from "../../src/host/store/index.js";

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

const newStore = () => createHostStore(reduceHost, initialHostAppState());

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

test("selectRendererBackend: TTY stdout (no flags) returns InkBackend", () => {
  const stdout = captureStdout(true);
  withNoColor(undefined, () => {
    const backend = selectRendererBackend({ stdout, store: newStore() });
    assert.ok(backend instanceof InkBackend, "expected InkBackend for TTY without flags");
    // Dispose so no Ink instance leaks; mount() was never called so this
    // is a no-op for the unmounted backend.
    backend.dispose?.();
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

test("selectRendererBackend: TTY path without a store throws a clear error", () => {
  const stdout = captureStdout(true);
  withNoColor(undefined, () => {
    assert.throws(
      () => selectRendererBackend({ stdout }),
      /store.*is required/u,
      "TTY selection must refuse to build an InkBackend without a store",
    );
  });
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
  const stdout = captureStdout(false);
  const backend = new JsonBackend(stdout);
  const frame = buildFrame();

  backend.render(frame);
  backend.render(frame);

  assert.equal(stdout.chunks.length, 0, "render(frame) must not write to stdout");
});

test("RendererBackend interface: Plain + Json backends are assignable to the type", () => {
  // Compile-time check materialized at runtime — instantiating each backend
  // proves the RendererBackend structural contract is satisfied. InkBackend
  // is covered by the selector test above (constructor requires a store).
  const stdout = captureStdout(false);
  const plain = new PlainBackend(stdout);
  const json = new JsonBackend(stdout);
  assert.equal(typeof plain.render, "function");
  assert.equal(typeof json.render, "function");
});
