import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  persistExperimentalCluster,
  runExperimentalCommand,
} from "../../src/host/commands/experimental.js";
import {
  EXPERIMENTAL_FLAGS,
  resetExperimentalConfigResolver,
  resetSessionExperimentalCluster,
} from "../../src/host/flags.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Printer = { lines: string[]; print: (line: string) => void };
const makePrinter = (): Printer => {
  const lines: string[] = [];
  return { lines, print: (line) => lines.push(line) };
};

const withTempConfig = async (fn: (path: string) => Promise<void>): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), "bakudo-experimental-"));
  const path = join(dir, "config.json");
  try {
    await fn(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

/**
 * Isolate env vars so the command's `show` output is deterministic across
 * whatever the surrounding shell has set.
 */
const withCleanEnv = async (fn: () => Promise<void>): Promise<void> => {
  const watched = [
    "BAKUDO_EXPERIMENTAL",
    ...EXPERIMENTAL_FLAGS.map((f) => `BAKUDO_EXPERIMENTAL_${f.name}`),
  ];
  const snapshot = new Map<string, string | undefined>();
  for (const name of watched) {
    snapshot.set(name, process.env[name]);
    delete process.env[name];
  }
  resetExperimentalConfigResolver();
  resetSessionExperimentalCluster();
  try {
    await fn();
  } finally {
    resetExperimentalConfigResolver();
    resetSessionExperimentalCluster();
    for (const name of watched) {
      const prior = snapshot.get(name);
      if (prior === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = prior;
      }
    }
  }
};

// ---------------------------------------------------------------------------
// No subcommand
// ---------------------------------------------------------------------------

test("no subcommand prints usage listing on/off/show", async () => {
  await withCleanEnv(async () => {
    const { lines, print } = makePrinter();
    await runExperimentalCommand({ args: [], print });
    assert.ok(lines.some((l) => l.includes("Usage:")));
    assert.ok(lines.some((l) => l.includes("/experimental on")));
    assert.ok(lines.some((l) => l.includes("/experimental off")));
    assert.ok(lines.some((l) => l.includes("/experimental show")));
  });
});

test("unknown subcommand prints usage + error line", async () => {
  await withCleanEnv(async () => {
    const { lines, print } = makePrinter();
    await runExperimentalCommand({ args: ["flarp"], print });
    assert.ok(lines.some((l) => l.includes("Unknown /experimental subcommand: flarp")));
    assert.ok(lines.some((l) => l.includes("Usage:")));
  });
});

// ---------------------------------------------------------------------------
// on / off — persistence + restart prompt
// ---------------------------------------------------------------------------

test("on: writes experimental=true to the user config and requests a restart", async () => {
  await withCleanEnv(async () => {
    await withTempConfig(async (configPath) => {
      const { lines, print } = makePrinter();
      let restartRequested = false;
      await runExperimentalCommand({
        args: ["on"],
        print,
        configPath,
        requestRestart: () => {
          restartRequested = true;
        },
      });
      const raw = await readFile(configPath, "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      assert.equal(parsed["experimental"], true);
      assert.ok(lines.some((l) => l.includes("cluster enabled")));
      assert.ok(lines.some((l) => l.includes("Restart bakudo")));
      assert.equal(restartRequested, true, "on should request a restart");
    });
  });
});

test("off: writes experimental=false and requests a restart", async () => {
  await withCleanEnv(async () => {
    await withTempConfig(async (configPath) => {
      // Seed with on so we are genuinely toggling off.
      await writeFile(configPath, JSON.stringify({ experimental: true }), "utf8");
      const { lines, print } = makePrinter();
      let restartRequested = false;
      await runExperimentalCommand({
        args: ["off"],
        print,
        configPath,
        requestRestart: () => {
          restartRequested = true;
        },
      });
      const raw = await readFile(configPath, "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      assert.equal(parsed["experimental"], false);
      assert.ok(lines.some((l) => l.includes("cluster disabled")));
      assert.ok(lines.some((l) => l.includes("Restart bakudo")));
      assert.equal(restartRequested, true, "off should request a restart");
    });
  });
});

test("on: preserves other top-level keys in the user config", async () => {
  await withCleanEnv(async () => {
    await withTempConfig(async (configPath) => {
      await writeFile(
        configPath,
        JSON.stringify({ mode: "plan", logLevel: "debug", futureKey: "hi" }),
        "utf8",
      );
      const { print } = makePrinter();
      await runExperimentalCommand({
        args: ["on"],
        print,
        configPath,
        requestRestart: () => {},
      });
      const raw = await readFile(configPath, "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      assert.equal(parsed["experimental"], true);
      assert.equal(parsed["mode"], "plan");
      assert.equal(parsed["logLevel"], "debug");
      // Forward-compat: unknown keys written by newer bakudo must survive.
      assert.equal(parsed["futureKey"], "hi");
    });
  });
});

test("on: creates parent directories when the XDG path does not yet exist", async () => {
  await withCleanEnv(async () => {
    const dir = await mkdtemp(join(tmpdir(), "bakudo-experimental-nodir-"));
    const configPath = join(dir, "deep", "nested", "config.json");
    try {
      const { print } = makePrinter();
      await runExperimentalCommand({
        args: ["on"],
        print,
        configPath,
        requestRestart: () => {},
      });
      const raw = await readFile(configPath, "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      assert.equal(parsed["experimental"], true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

test("on: does NOT request restart when the hook is omitted (library-mode)", async () => {
  await withCleanEnv(async () => {
    await withTempConfig(async (configPath) => {
      const { lines, print } = makePrinter();
      // Intentionally omit requestRestart — the command must still succeed
      // and print the restart prompt for UX, without crashing.
      await runExperimentalCommand({ args: ["on"], print, configPath });
      assert.ok(lines.some((l) => l.includes("Restart bakudo")));
    });
  });
});

// ---------------------------------------------------------------------------
// show
// ---------------------------------------------------------------------------

test("show: lists every registered flag with its current on/off state", async () => {
  await withCleanEnv(async () => {
    const { lines, print } = makePrinter();
    await runExperimentalCommand({ args: ["show"], print });
    // Header mentions the count.
    assert.ok(
      lines.some((l) => l.includes(`${EXPERIMENTAL_FLAGS.length} feature(s) registered`)),
      `header missing; got:\n${lines.join("\n")}`,
    );
    for (const flag of EXPERIMENTAL_FLAGS) {
      const line = lines.find((l) => l.includes(flag.name));
      assert.ok(line, `expected a line for ${flag.name}`);
      assert.ok(line.includes("[off]"), `${flag.name} should render as off by default`);
      assert.ok(line.includes(flag.description));
    }
  });
});

test("show: renders enabled flags as [on]", async () => {
  await withCleanEnv(async () => {
    process.env["BAKUDO_EXPERIMENTAL_QUICK_SEARCH"] = "1";
    const { lines, print } = makePrinter();
    await runExperimentalCommand({ args: ["show"], print });
    const line = lines.find((l) => l.includes("QUICK_SEARCH"));
    assert.ok(line);
    assert.ok(line.includes("[on]"));
  });
});

test("show: renders all-on when BAKUDO_EXPERIMENTAL=all", async () => {
  await withCleanEnv(async () => {
    process.env["BAKUDO_EXPERIMENTAL"] = "all";
    const { lines, print } = makePrinter();
    await runExperimentalCommand({ args: ["show"], print });
    for (const flag of EXPERIMENTAL_FLAGS) {
      const line = lines.find((l) => l.includes(flag.name));
      assert.ok(line);
      assert.ok(line.includes("[on]"), `${flag.name} should be on under =all`);
    }
  });
});

// ---------------------------------------------------------------------------
// persistExperimentalCluster (direct)
// ---------------------------------------------------------------------------

test("persistExperimentalCluster: atomic write (no .tmp file left behind on success)", async () => {
  await withCleanEnv(async () => {
    await withTempConfig(async (configPath) => {
      await persistExperimentalCluster(true, configPath);
      // `<path>.tmp` must not exist after the rename completes.
      await assert.rejects(readFile(`${configPath}.tmp`, "utf8"));
    });
  });
});

test("persistExperimentalCluster: tolerates unreadable prior config (missing file)", async () => {
  await withCleanEnv(async () => {
    const dir = await mkdtemp(join(tmpdir(), "bakudo-experimental-miss-"));
    const configPath = join(dir, "config.json");
    try {
      await persistExperimentalCluster(true, configPath);
      const raw = await readFile(configPath, "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      assert.equal(parsed["experimental"], true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

test("persistExperimentalCluster: tolerates malformed prior config (writes fresh)", async () => {
  await withCleanEnv(async () => {
    await withTempConfig(async (configPath) => {
      await writeFile(configPath, "{ not valid json", "utf8");
      await persistExperimentalCluster(true, configPath);
      const raw = await readFile(configPath, "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      assert.equal(parsed["experimental"], true);
    });
  });
});
