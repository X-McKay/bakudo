import assert from "node:assert/strict";
import test from "node:test";

import {
  cleanupHandlerCount,
  clearCleanupHandlers,
  installSignalHandlers,
  registerCleanupHandler,
  runCleanupHandlers,
} from "../../src/host/signalHandlers.js";

type ListenerMap = Map<string, Set<(...args: unknown[]) => void>>;

const createFakeProcess = (): {
  proc: {
    on: (event: string, listener: (...args: unknown[]) => void) => unknown;
    off: (event: string, listener: (...args: unknown[]) => void) => unknown;
    stderr: { write: (chunk: string) => unknown };
    exit: (code?: number) => never;
  };
  listeners: ListenerMap;
  stderrChunks: string[];
  exitCalls: number[];
  emit: (event: string, ...args: unknown[]) => void;
} => {
  const listeners: ListenerMap = new Map();
  const stderrChunks: string[] = [];
  const exitCalls: number[] = [];
  const proc = {
    on: (event: string, listener: (...args: unknown[]) => void): unknown => {
      let set = listeners.get(event);
      if (set === undefined) {
        set = new Set();
        listeners.set(event, set);
      }
      set.add(listener);
      return undefined;
    },
    off: (event: string, listener: (...args: unknown[]) => void): unknown => {
      listeners.get(event)?.delete(listener);
      return undefined;
    },
    stderr: {
      write: (chunk: string) => {
        stderrChunks.push(chunk);
        return true;
      },
    },
    exit: (code?: number): never => {
      exitCalls.push(code ?? 0);
      // `never` is a type-only lie here; we return undefined cast to never so
      // the handler continues execution deterministically in tests.
      return undefined as never;
    },
  };
  const emit = (event: string, ...args: unknown[]): void => {
    const set = listeners.get(event);
    if (set === undefined) {
      return;
    }
    for (const listener of Array.from(set)) {
      listener(...args);
    }
  };
  return { proc, listeners, stderrChunks, exitCalls, emit };
};

test("registerCleanupHandler: returns a working unregister function", () => {
  clearCleanupHandlers();
  const unregister = registerCleanupHandler(() => {});
  assert.equal(cleanupHandlerCount(), 1, "one handler registered");
  unregister();
  assert.equal(cleanupHandlerCount(), 0, "unregister removed the handler");
  clearCleanupHandlers();
});

test("registerCleanupHandler: unregister twice is a no-op", () => {
  clearCleanupHandlers();
  const unregister = registerCleanupHandler(() => {});
  unregister();
  unregister();
  assert.equal(cleanupHandlerCount(), 0);
  clearCleanupHandlers();
});

test("runCleanupHandlers: LIFO order (last registered runs first)", async () => {
  clearCleanupHandlers();
  const order: string[] = [];
  registerCleanupHandler(() => {
    order.push("a");
  });
  registerCleanupHandler(() => {
    order.push("b");
  });
  registerCleanupHandler(() => {
    order.push("c");
  });
  await runCleanupHandlers();
  assert.deepEqual(order, ["c", "b", "a"], "handlers ran LIFO");
  clearCleanupHandlers();
});

test("runCleanupHandlers: handler error does not block subsequent cleanups", async () => {
  clearCleanupHandlers();
  const order: string[] = [];
  registerCleanupHandler(() => {
    order.push("a");
  });
  registerCleanupHandler(() => {
    throw new Error("boom");
  });
  registerCleanupHandler(() => {
    order.push("c");
  });
  await runCleanupHandlers();
  assert.deepEqual(order, ["c", "a"], "'a' still runs after 'b' throws");
  clearCleanupHandlers();
});

test("runCleanupHandlers: async handler rejection does not block subsequent", async () => {
  clearCleanupHandlers();
  const order: string[] = [];
  registerCleanupHandler(async () => {
    order.push("a");
  });
  registerCleanupHandler(async () => {
    throw new Error("async-boom");
  });
  registerCleanupHandler(async () => {
    order.push("c");
  });
  await runCleanupHandlers();
  assert.deepEqual(order, ["c", "a"], "'a' still runs after async rejection");
  clearCleanupHandlers();
});

test("runCleanupHandlers: clears the list after running", async () => {
  clearCleanupHandlers();
  registerCleanupHandler(() => {});
  registerCleanupHandler(() => {});
  await runCleanupHandlers();
  assert.equal(cleanupHandlerCount(), 0, "handlers cleared after run");
});

test("installSignalHandlers: returns a working uninstaller", () => {
  const fake = createFakeProcess();
  const uninstall = installSignalHandlers({ process: fake.proc });
  assert.ok(fake.listeners.get("SIGINT") !== undefined, "SIGINT listener registered");
  assert.ok(fake.listeners.get("SIGTERM") !== undefined, "SIGTERM listener registered");
  assert.ok(
    fake.listeners.get("uncaughtException") !== undefined,
    "uncaughtException listener registered",
  );
  assert.ok(
    fake.listeners.get("unhandledRejection") !== undefined,
    "unhandledRejection listener registered",
  );
  uninstall();
  assert.equal(fake.listeners.get("SIGINT")?.size, 0, "SIGINT listener removed");
  assert.equal(fake.listeners.get("SIGTERM")?.size, 0, "SIGTERM listener removed");
  assert.equal(
    fake.listeners.get("uncaughtException")?.size,
    0,
    "uncaughtException listener removed",
  );
  assert.equal(
    fake.listeners.get("unhandledRejection")?.size,
    0,
    "unhandledRejection listener removed",
  );
});

test("installSignalHandlers: SIGINT triggers cleanup + exit(130)", async () => {
  clearCleanupHandlers();
  const fake = createFakeProcess();
  const ran: string[] = [];
  registerCleanupHandler(() => {
    ran.push("cleaned");
  });
  const signals: Array<string | Error> = [];
  installSignalHandlers({
    process: fake.proc,
    exit: (code: number) => fake.proc.exit(code),
    onFatal: (s) => signals.push(s),
  });

  fake.emit("SIGINT");
  // The handler is async; yield to the event loop to let cleanup + exit fire.
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(ran, ["cleaned"], "cleanup handler ran on SIGINT");
  assert.deepEqual(fake.exitCalls, [130], "process.exit(130) invoked");
  assert.deepEqual(signals, ["SIGINT"], "onFatal got 'SIGINT'");
  clearCleanupHandlers();
});

test("installSignalHandlers: SIGTERM triggers cleanup + exit(143)", async () => {
  clearCleanupHandlers();
  const fake = createFakeProcess();
  registerCleanupHandler(() => {});
  const signals: Array<string | Error> = [];
  installSignalHandlers({
    process: fake.proc,
    exit: (code: number) => fake.proc.exit(code),
    onFatal: (s) => signals.push(s),
  });

  fake.emit("SIGTERM");
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(fake.exitCalls, [143], "process.exit(143) invoked");
  assert.deepEqual(signals, ["SIGTERM"]);
  clearCleanupHandlers();
});

test("installSignalHandlers: uncaughtException triggers cleanup + exit(1) + stderr", async () => {
  clearCleanupHandlers();
  const fake = createFakeProcess();
  const ran: string[] = [];
  registerCleanupHandler(() => {
    ran.push("cleaned");
  });
  installSignalHandlers({
    process: fake.proc,
    exit: (code: number) => fake.proc.exit(code),
  });

  fake.emit("uncaughtException", new Error("test-uncaught"));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(ran, ["cleaned"]);
  assert.deepEqual(fake.exitCalls, [1], "exit(1) on uncaughtException");
  const joined = fake.stderrChunks.join("");
  assert.match(joined, /uncaught_exception: test-uncaught/);
  clearCleanupHandlers();
});

test("installSignalHandlers: unhandledRejection triggers cleanup + exit(1) + stderr", async () => {
  clearCleanupHandlers();
  const fake = createFakeProcess();
  registerCleanupHandler(() => {});
  installSignalHandlers({
    process: fake.proc,
    exit: (code: number) => fake.proc.exit(code),
  });

  fake.emit("unhandledRejection", new Error("promise-failed"), Promise.resolve());
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(fake.exitCalls, [1]);
  const joined = fake.stderrChunks.join("");
  assert.match(joined, /unhandled_rejection: promise-failed/);
  clearCleanupHandlers();
});

test("installSignalHandlers: uninstall prevents further invocations", async () => {
  clearCleanupHandlers();
  const fake = createFakeProcess();
  const ran: string[] = [];
  registerCleanupHandler(() => {
    ran.push("cleaned");
  });
  const uninstall = installSignalHandlers({
    process: fake.proc,
    exit: (code: number) => fake.proc.exit(code),
  });

  uninstall();
  fake.emit("SIGINT");
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(ran, [], "cleanup did not run because handlers were uninstalled");
  assert.deepEqual(fake.exitCalls, [], "no exit call after uninstall");
  clearCleanupHandlers();
});

test("installSignalHandlers: missing process (no-op env) returns trivial uninstaller", () => {
  // An empty process shape (no .on/.off) exercises the no-op branch.
  const uninstall = installSignalHandlers({ process: {} });
  assert.equal(typeof uninstall, "function", "returned uninstaller is callable");
  // Calling it must not throw.
  uninstall();
});
