import test from "node:test";
import assert from "node:assert/strict";

import { runCli } from "../../src/cli.js";
import { withCapturedStdout } from "../../src/host/io.js";
import { shouldUseHostCli } from "../../src/host/parsing.js";

type Capture = {
  writer: { write: (chunk: string) => boolean };
  chunks: string[];
};

const capture = (): Capture => {
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

test("F-01: shouldUseHostCli routes --version to host CLI", () => {
  assert.equal(shouldUseHostCli(["--version"]), true);
});

test("F-01: shouldUseHostCli routes -V to host CLI", () => {
  assert.equal(shouldUseHostCli(["-V"]), true);
});

test("F-01: shouldUseHostCli still routes --help to host CLI", () => {
  assert.equal(shouldUseHostCli(["--help"]), true);
  assert.equal(shouldUseHostCli(["-h"]), true);
});

test("F-01: shouldUseHostCli still sends unknown --flag to legacy parser", () => {
  assert.equal(shouldUseHostCli(["--foobar"]), false);
});

test("F-01: bakudo --version prints the version and exits 0", async () => {
  const cap = capture();
  const exit = await withCapturedStdout(cap.writer, () => runCli(["--version"]));
  assert.equal(exit, 0);
  assert.match(cap.chunks.join(""), /^bakudo \S+\n$/u);
});

test("F-01: bakudo -V prints the version and exits 0", async () => {
  const cap = capture();
  const exit = await withCapturedStdout(cap.writer, () => runCli(["-V"]));
  assert.equal(exit, 0);
  assert.match(cap.chunks.join(""), /^bakudo \S+\n$/u);
});

test("F-01: --version with --output-format=json prints an envelope", async () => {
  const cap = capture();
  const exit = await withCapturedStdout(cap.writer, () =>
    runCli(["--version", "--output-format=json"]),
  );
  assert.equal(exit, 0);
  const parsed = JSON.parse(cap.chunks.join("")) as { version?: string };
  assert.equal(typeof parsed.version, "string");
});
