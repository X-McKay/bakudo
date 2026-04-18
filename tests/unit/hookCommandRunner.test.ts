/**
 * Wave 6c PR9 — user-configurable command-hook dispatcher tests.
 *
 * Each rule from plan 06 lines 759–764 has a 1:1 test below:
 *   Rule 1. Envelope is passed as JSON on stdin.
 *   Rule 2. HookResponse is parsed from stdout and validated.
 *   Rule 3. permissionRequest allows approve/deny; others reject them.
 *   Rule 4. Block produces PolicyDeniedError with hook: <name> in details.
 *   Rule 5. 10s hard timeout (probed at a shorter value for test speed).
 *   Rule 6. Non-zero exit is treated as block.
 */

import { EventEmitter } from "node:events";
import test from "node:test";
import assert from "node:assert/strict";

import type { ChildProcess } from "node:child_process";

import {
  runConfiguredCommandHooks,
  type CommandHookEntry,
  type CommandHookSpawnFn,
  type CommandHooksConfig,
} from "../../src/host/hookCommandRunner.js";
import { PolicyDeniedError } from "../../src/host/errors.js";
import type { SessionEventEnvelope } from "../../src/protocol.js";

type FakeChild = ChildProcess & {
  __stdinWrites: string[];
  __finish: (exitCode: number, stdoutText?: string) => void;
  __stall: () => void;
};

/**
 * Build a ChildProcess-shaped EventEmitter suitable for injecting into the
 * runner. Matches the same pattern used in `aboxAdapter.test.ts` — all three
 * streams are bare EventEmitters so there are no Readable/Writable
 * async-iterator lifecycles for the test runner to police.
 */
const makeFakeChild = (): FakeChild => {
  const stdinWrites: string[] = [];
  const stdin = new EventEmitter() as EventEmitter & {
    write: (data: unknown) => boolean;
    end: () => void;
    destroy: () => void;
  };
  stdin.write = (data: unknown) => {
    stdinWrites.push(
      typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString("utf8") : "",
    );
    return true;
  };
  stdin.end = () => undefined;
  stdin.destroy = () => undefined;
  const stdout = new EventEmitter() as EventEmitter & { destroy?: () => void };
  const stderr = new EventEmitter() as EventEmitter & { destroy?: () => void };
  stdout.destroy = () => stdout.emit("close");
  stderr.destroy = () => stderr.emit("close");

  const emitter = new EventEmitter() as ChildProcess & { __stdinWrites: string[] };
  (emitter as unknown as Record<string, unknown>).stdin = stdin;
  (emitter as unknown as Record<string, unknown>).stdout = stdout;
  (emitter as unknown as Record<string, unknown>).stderr = stderr;
  (emitter as unknown as Record<string, unknown>).kill = () => true;
  (emitter as unknown as Record<string, unknown>).__stdinWrites = stdinWrites;
  const child = emitter as FakeChild;
  child.__stdinWrites = stdinWrites;
  child.__finish = (exitCode, stdoutText) => {
    // Defer stream + close events until after the runner has attached its
    // listeners. spawnFn returns synchronously, then drainStream + the
    // exit-promise register; those complete before this microtask fires.
    queueMicrotask(() => {
      if (stdoutText !== undefined && stdoutText.length > 0) {
        stdout.emit("data", stdoutText);
      }
      stdout.emit("end");
      stderr.emit("end");
      emitter.emit("close", exitCode, null);
    });
  };
  child.__stall = () => {
    // never ends streams, never emits close — runner must time out and then
    // destroy() the streams (which emits 'close' on our stub so drain can
    // resolve without leaking).
  };
  return child;
};

const stubEnvelope = (): SessionEventEnvelope =>
  ({
    schemaVersion: 2,
    eventId: "event-1",
    kind: "host.turn_queued",
    sessionId: "s1",
    actor: "host",
    timestamp: "2026-04-18T00:00:00.000Z",
    payload: { turnId: "t1", prompt: "hi", mode: "build" },
  }) as SessionEventEnvelope;

const entry = (command: string): CommandHookEntry => ({ type: "command", command });

// ---------------------------------------------------------------------------
// Rule 1 — envelope on stdin
// ---------------------------------------------------------------------------

test("rule 1: envelope is written to hook stdin as JSON", async () => {
  const env = stubEnvelope();
  const child = makeFakeChild();
  const spawnFn: CommandHookSpawnFn = () => {
    child.__finish(0, JSON.stringify({ action: "continue" }));
    return child;
  };
  const config: CommandHooksConfig = { preToolUse: [entry("/bin/true")] };
  await runConfiguredCommandHooks("preToolUse", env, config, { spawnFn });
  assert.equal(child.__stdinWrites.length >= 1, true, "expected at least one stdin write");
  const joined = child.__stdinWrites.join("");
  const parsed = JSON.parse(joined.trim()) as { kind: string; sessionId: string };
  assert.equal(parsed.kind, "host.turn_queued");
  assert.equal(parsed.sessionId, "s1");
});

// ---------------------------------------------------------------------------
// Rule 2 — HookResponse JSON parsing + validation
// ---------------------------------------------------------------------------

test("rule 2: returns continue on a well-formed HookResponse", async () => {
  const child = makeFakeChild();
  const spawnFn: CommandHookSpawnFn = () => {
    child.__finish(0, JSON.stringify({ action: "continue", reason: "ok" }));
    return child;
  };
  const outcome = await runConfiguredCommandHooks(
    "preToolUse",
    stubEnvelope(),
    { preToolUse: [entry("/bin/true")] },
    { spawnFn },
  );
  assert.equal(outcome.action, "continue");
  assert.equal(outcome.reason, "ok");
  assert.equal(outcome.handlersRun, 1);
});

test("rule 2: non-JSON stdout is a block", async () => {
  const child = makeFakeChild();
  const spawnFn: CommandHookSpawnFn = () => {
    child.__finish(0, "not json at all");
    return child;
  };
  await assert.rejects(
    () =>
      runConfiguredCommandHooks(
        "preToolUse",
        stubEnvelope(),
        { preToolUse: [entry("/bin/true")] },
        { spawnFn },
      ),
    (err: unknown) => {
      assert.ok(err instanceof PolicyDeniedError);
      assert.equal((err.details as { hook?: string }).hook, "preToolUse");
      assert.equal((err.details as { cause?: string }).cause, "invalid_response");
      return true;
    },
  );
});

test("rule 2: malformed HookResponse (bad action enum) is a block", async () => {
  const child = makeFakeChild();
  const spawnFn: CommandHookSpawnFn = () => {
    child.__finish(0, JSON.stringify({ action: "banana" }));
    return child;
  };
  await assert.rejects(
    () =>
      runConfiguredCommandHooks(
        "preToolUse",
        stubEnvelope(),
        { preToolUse: [entry("/bin/true")] },
        { spawnFn },
      ),
    (err: unknown) => {
      assert.ok(err instanceof PolicyDeniedError);
      assert.equal((err.details as { cause?: string }).cause, "invalid_response");
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Rule 3 — action matrix per kind
// ---------------------------------------------------------------------------

test("rule 3: permissionRequest permits approve", async () => {
  const child = makeFakeChild();
  const spawnFn: CommandHookSpawnFn = () => {
    child.__finish(0, JSON.stringify({ action: "approve", reason: "ok by policy" }));
    return child;
  };
  const outcome = await runConfiguredCommandHooks(
    "permissionRequest",
    stubEnvelope(),
    { permissionRequest: [entry("/bin/true")] },
    { spawnFn },
  );
  assert.equal(outcome.action, "approve");
  assert.equal(outcome.reason, "ok by policy");
});

test("rule 3: permissionRequest permits deny (throws block)", async () => {
  const child = makeFakeChild();
  const spawnFn: CommandHookSpawnFn = () => {
    child.__finish(0, JSON.stringify({ action: "deny", reason: "nope" }));
    return child;
  };
  await assert.rejects(
    () =>
      runConfiguredCommandHooks(
        "permissionRequest",
        stubEnvelope(),
        { permissionRequest: [entry("/bin/true")] },
        { spawnFn },
      ),
    (err: unknown) => {
      assert.ok(err instanceof PolicyDeniedError);
      assert.equal((err.details as { hook?: string }).hook, "permissionRequest");
      assert.equal((err.details as { cause?: string }).cause, "deny");
      assert.match(err.message, /nope/);
      return true;
    },
  );
});

test("rule 3: preToolUse rejects approve (wrong kind)", async () => {
  const child = makeFakeChild();
  const spawnFn: CommandHookSpawnFn = () => {
    child.__finish(0, JSON.stringify({ action: "approve" }));
    return child;
  };
  await assert.rejects(
    () =>
      runConfiguredCommandHooks(
        "preToolUse",
        stubEnvelope(),
        { preToolUse: [entry("/bin/true")] },
        { spawnFn },
      ),
    (err: unknown) => {
      assert.ok(err instanceof PolicyDeniedError);
      assert.equal((err.details as { hook?: string }).hook, "preToolUse");
      assert.equal((err.details as { cause?: string }).cause, "invalid_response");
      assert.match(err.message, /only "continue" \/ "block" are allowed/);
      return true;
    },
  );
});

test("rule 3: postToolUse rejects deny (wrong kind)", async () => {
  const child = makeFakeChild();
  const spawnFn: CommandHookSpawnFn = () => {
    child.__finish(0, JSON.stringify({ action: "deny" }));
    return child;
  };
  await assert.rejects(
    () =>
      runConfiguredCommandHooks(
        "postToolUse",
        stubEnvelope(),
        { postToolUse: [entry("/bin/true")] },
        { spawnFn },
      ),
    (err: unknown) => {
      assert.ok(err instanceof PolicyDeniedError);
      assert.equal((err.details as { hook?: string }).hook, "postToolUse");
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Rule 4 — PolicyDeniedError carries hook: <name>
// ---------------------------------------------------------------------------

test("rule 4: explicit block emits PolicyDeniedError with hook name in details", async () => {
  const child = makeFakeChild();
  const spawnFn: CommandHookSpawnFn = () => {
    child.__finish(0, JSON.stringify({ action: "block", reason: "nuclear-launch-guard" }));
    return child;
  };
  await assert.rejects(
    () =>
      runConfiguredCommandHooks(
        "sessionStart",
        stubEnvelope(),
        { sessionStart: [entry("/bin/true")] },
        { spawnFn },
      ),
    (err: unknown) => {
      assert.ok(err instanceof PolicyDeniedError);
      assert.equal(err.code, "policy_denied");
      assert.equal(err.exitCode, 3);
      assert.equal((err.details as { hook?: string }).hook, "sessionStart");
      assert.equal((err.details as { cause?: string }).cause, "block");
      assert.equal((err.details as { reason?: string }).reason, "nuclear-launch-guard");
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Rule 5 — hard timeout (probed at 40 ms for test speed; default is 10_000)
// ---------------------------------------------------------------------------

test("rule 5: hook that does not exit within timeout becomes a block", async () => {
  const child = makeFakeChild();
  const spawnFn: CommandHookSpawnFn = () => {
    child.__stall();
    return child;
  };
  await assert.rejects(
    () =>
      runConfiguredCommandHooks(
        "preToolUse",
        stubEnvelope(),
        { preToolUse: [entry("/bin/true")] },
        { spawnFn, timeoutMs: 40 },
      ),
    (err: unknown) => {
      assert.ok(err instanceof PolicyDeniedError);
      assert.equal((err.details as { cause?: string }).cause, "timeout");
      assert.match(err.message, /timed out after 40ms/);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Rule 6 — non-zero exit → block
// ---------------------------------------------------------------------------

test("rule 6: non-zero exit is treated as block", async () => {
  const child = makeFakeChild();
  const spawnFn: CommandHookSpawnFn = () => {
    child.__finish(7, ""); // exit 7, no stdout
    return child;
  };
  await assert.rejects(
    () =>
      runConfiguredCommandHooks(
        "preToolUse",
        stubEnvelope(),
        { preToolUse: [entry("/bin/true")] },
        { spawnFn },
      ),
    (err: unknown) => {
      assert.ok(err instanceof PolicyDeniedError);
      assert.equal((err.details as { cause?: string }).cause, "exit_nonzero");
      assert.equal((err.details as { exitCode?: number }).exitCode, 7);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Plumbing — empty config
// ---------------------------------------------------------------------------

test("no hooks configured: returns continue without spawning", async () => {
  let spawns = 0;
  const spawnFn: CommandHookSpawnFn = () => {
    spawns += 1;
    const child = makeFakeChild();
    child.__finish(0, JSON.stringify({ action: "continue" }));
    return child;
  };
  const outcome = await runConfiguredCommandHooks("preToolUse", stubEnvelope(), undefined, {
    spawnFn,
  });
  assert.equal(outcome.action, "continue");
  assert.equal(outcome.handlersRun, 0);
  assert.equal(spawns, 0);
});

test("sequential hooks: last continue wins; first block short-circuits", async () => {
  const spawns: string[] = [];
  const spawnFn: CommandHookSpawnFn = (cmd: string) => {
    spawns.push(cmd);
    const child = makeFakeChild();
    if (cmd === "/run/first") {
      child.__finish(0, JSON.stringify({ action: "continue" }));
    } else if (cmd === "/run/second") {
      child.__finish(0, JSON.stringify({ action: "continue" }));
    } else {
      child.__finish(0, JSON.stringify({ action: "block", reason: "stop" }));
    }
    return child;
  };
  const outcome = await runConfiguredCommandHooks(
    "preToolUse",
    stubEnvelope(),
    {
      preToolUse: [entry("/run/first"), entry("/run/second")],
    },
    { spawnFn },
  );
  assert.equal(outcome.action, "continue");
  assert.equal(outcome.handlersRun, 2);
  assert.deepEqual(spawns, ["/run/first", "/run/second"]);

  const spawns2: string[] = [];
  const spawnFn2: CommandHookSpawnFn = (cmd: string) => {
    spawns2.push(cmd);
    const child = makeFakeChild();
    if (cmd === "/run/first") {
      child.__finish(0, JSON.stringify({ action: "block", reason: "stop" }));
    } else {
      child.__finish(0, JSON.stringify({ action: "continue" }));
    }
    return child;
  };
  await assert.rejects(
    () =>
      runConfiguredCommandHooks(
        "preToolUse",
        stubEnvelope(),
        { preToolUse: [entry("/run/first"), entry("/run/never")] },
        { spawnFn: spawnFn2 },
      ),
    (err: unknown) => err instanceof PolicyDeniedError,
  );
  assert.deepEqual(spawns2, ["/run/first"], "second hook MUST NOT run after first blocks");
});
