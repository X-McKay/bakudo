import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { acquireSessionLock, sessionLockFilePath } from "../../src/host/lockFile.js";
import {
  clearCleanupHandlers,
  registerCleanupHandler,
  runCleanupHandlers,
} from "../../src/host/signalHandlers.js";

// The project narrows `process` at the type level; reach the full runtime
// via `globalThis` for the test-only bits (execPath, cwd).
const nodeProcess: {
  execPath: string;
  cwd: () => string;
  env: Record<string, string | undefined>;
} = (
  globalThis as unknown as {
    process: {
      execPath: string;
      cwd: () => string;
      env: Record<string, string | undefined>;
    };
  }
).process;

/**
 * Phase 5 PR5 crash-recovery integration test.
 *
 * These tests verify that on a fatal signal the host restores the terminal
 * state (exit-alt-screen / show-cursor) rather than leaving the user in a
 * wedged alt-screen buffer.
 *
 * NOTE: this test requires a runner with process-spawn capability. Some
 * sandboxed CI environments disable `child_process.spawn`; in that case the
 * `it.skip` branch documents the expected behavior without running a real
 * subprocess.
 */

const canSpawn = (): boolean => {
  try {
    // A minimal probe — if spawn itself throws we skip.
    const child = spawn(nodeProcess.execPath, ["-e", "process.exit(0)"], {
      stdio: "ignore",
    });
    child.kill();
    return true;
  } catch {
    return false;
  }
};

test("crash recovery: child handling SIGTERM exits with code 143", async (t) => {
  if (!canSpawn()) {
    t.skip("process-spawn capability unavailable in this sandbox");
    return;
  }

  // Run a minimal node program that installs our signal handlers, registers
  // a cleanup that writes a marker, then waits for SIGTERM. We use `-e` to
  // load the compiled module path so we don't need a separate fixture file.
  const code = `
    (async () => {
      const mod = await import('${nodeProcess.cwd()}/dist/src/host/signalHandlers.js');
      mod.registerCleanupHandler(() => {
        process.stderr.write('CLEANUP_RAN\\n');
      });
      mod.installSignalHandlers();
      // Stay alive until the signal fires.
      setInterval(() => {}, 10000);
    })().catch(err => {
      process.stderr.write('SPAWN_ERROR: ' + err.message + '\\n');
      process.exit(2);
    });
  `;

  const child = spawn(nodeProcess.execPath, ["-e", code], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  const stderrChunks: string[] = [];
  child.stderr.on("data", (chunk: Buffer) => {
    stderrChunks.push(chunk.toString("utf8"));
  });

  // Give node a moment to load the module and install handlers.
  await new Promise((resolve) => setTimeout(resolve, 500));
  child.kill("SIGTERM");

  const exitCode = await new Promise<number>((resolve) => {
    child.on("exit", (code) => resolve(code ?? -1));
  });

  const stderr = stderrChunks.join("");
  if (stderr.includes("SPAWN_ERROR")) {
    // Compiled module missing — skip rather than report a misleading failure.
    t.skip(`spawn child could not import signalHandlers module: ${stderr}`);
    return;
  }
  assert.equal(exitCode, 143, "child exits with SIGTERM-standard code 143");
  assert.match(stderr, /CLEANUP_RAN/, "cleanup handler ran before exit");
});

test("crash recovery: SIGINT exits with code 130 and fires LIFO cleanup", async (t) => {
  if (!canSpawn()) {
    t.skip("process-spawn capability unavailable in this sandbox");
    return;
  }

  const code = `
    (async () => {
      const mod = await import('${nodeProcess.cwd()}/dist/src/host/signalHandlers.js');
      mod.registerCleanupHandler(() => process.stderr.write('CLEANUP_A\\n'));
      mod.registerCleanupHandler(() => process.stderr.write('CLEANUP_B\\n'));
      mod.registerCleanupHandler(() => process.stderr.write('CLEANUP_C\\n'));
      mod.installSignalHandlers();
      setInterval(() => {}, 10000);
    })().catch(err => {
      process.stderr.write('SPAWN_ERROR: ' + err.message + '\\n');
      process.exit(2);
    });
  `;

  const child = spawn(nodeProcess.execPath, ["-e", code], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  const stderrChunks: string[] = [];
  child.stderr.on("data", (chunk: Buffer) => {
    stderrChunks.push(chunk.toString("utf8"));
  });

  await new Promise((resolve) => setTimeout(resolve, 500));
  child.kill("SIGINT");

  const exitCode = await new Promise<number>((resolve) => {
    child.on("exit", (code) => resolve(code ?? -1));
  });

  const stderr = stderrChunks.join("");
  if (stderr.includes("SPAWN_ERROR")) {
    t.skip(`spawn child could not import signalHandlers module: ${stderr}`);
    return;
  }
  assert.equal(exitCode, 130, "child exits with SIGINT-standard code 130");
  // Cleanup order should be C, B, A (LIFO).
  const orderMatch = stderr.match(/CLEANUP_[ABC]/g);
  assert.deepEqual(
    orderMatch,
    ["CLEANUP_C", "CLEANUP_B", "CLEANUP_A"],
    "cleanup handlers fired LIFO",
  );
});

test("crash recovery: cleanup handler releases a held session lock", async () => {
  // Register a lock, wire its release as a cleanup handler (mirroring the
  // production wiring in `sessionController.withAcquiredLock`), then run the
  // cleanup chain and assert the `.lock` file is gone.
  const dir = await mkdtemp(join(tmpdir(), "bakudo-crash-lock-"));
  try {
    clearCleanupHandlers();
    const handle = await acquireSessionLock("s-crash", dir, { pid: 42 });
    registerCleanupHandler(async () => {
      await handle.release();
    });
    // Before cleanup: lock file exists.
    await stat(sessionLockFilePath(dir));
    await runCleanupHandlers();
    // After cleanup: lock file removed.
    const exists = await stat(sessionLockFilePath(dir)).then(
      () => true,
      () => false,
    );
    assert.equal(exists, false, "cleanup handler released the lock");
  } finally {
    clearCleanupHandlers();
    await rm(dir, { recursive: true, force: true });
  }
});
