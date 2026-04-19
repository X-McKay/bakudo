import assert from "node:assert/strict";
import test from "node:test";

import { initialHostAppState } from "../../src/host/appState.js";
import { stdoutWrite } from "../../src/host/io.js";
import {
  executePrompt,
  type ExecuteDeps,
  type TickDeps,
} from "../../src/host/interactiveRenderLoop.js";
import type { HostCliArgs } from "../../src/host/parsing.js";

const buildArgs = (command: HostCliArgs["command"]): HostCliArgs => ({
  command,
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
});

test("executePrompt: non-exec stdout is captured as one output transcript block", async () => {
  const deps: TickDeps = {
    transcript: [],
    appState: initialHostAppState(),
  };
  let remembered = false;
  const exec: ExecuteDeps = {
    resolveInput: () => ({ argv: ["sessions"] }),
    parse: () => buildArgs("sessions"),
    dispatch: async () => {
      stdoutWrite("alpha\nbeta\n");
      return 0;
    },
    remember: () => {
      remembered = true;
    },
  };

  await executePrompt("sessions", deps, exec);

  assert.equal(remembered, true);
  assert.deepEqual(deps.transcript, [{ kind: "output", text: "alpha\nbeta" }]);
});
