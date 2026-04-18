import assert from "node:assert/strict";
import test from "node:test";

import {
  EXPERIMENTAL_FLAGS,
  experimental,
  resetExperimentalConfigResolver,
  resetSessionExperimentalCluster,
  setExperimentalConfigResolver,
  setSessionExperimentalCluster,
  summarizeExperimentalFlags,
} from "../../src/host/flags.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Snapshot-and-restore the env vars the flag accessor cares about so each
 * test runs against a clean slate regardless of how the surrounding shell
 * was configured. Returns a disposer.
 */
const isolateEnv = (): (() => void) => {
  const watched = [
    "BAKUDO_EXPERIMENTAL",
    ...EXPERIMENTAL_FLAGS.map((f) => `BAKUDO_EXPERIMENTAL_${f.name}`),
    "BAKUDO_EXPERIMENTAL_UNKNOWN",
    "BAKUDO_EXPERIMENTAL_FAKE",
  ];
  const snapshot = new Map<string, string | undefined>();
  for (const name of watched) {
    snapshot.set(name, process.env[name]);
    delete process.env[name];
  }
  return () => {
    for (const name of watched) {
      const prior = snapshot.get(name);
      if (prior === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = prior;
      }
    }
  };
};

const withClean = (fn: () => void | Promise<void>): (() => Promise<void>) => {
  return async () => {
    const restore = isolateEnv();
    resetExperimentalConfigResolver();
    resetSessionExperimentalCluster();
    try {
      await fn();
    } finally {
      resetExperimentalConfigResolver();
      resetSessionExperimentalCluster();
      restore();
    }
  };
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

test("EXPERIMENTAL_FLAGS: registers at least QUICK_SEARCH and RICH_TUI", () => {
  const names = new Set(EXPERIMENTAL_FLAGS.map((f) => f.name));
  assert.ok(names.has("QUICK_SEARCH"), "QUICK_SEARCH flag should be registered");
  assert.ok(names.has("RICH_TUI"), "RICH_TUI flag should be registered");
});

test("EXPERIMENTAL_FLAGS: every entry has a non-empty description", () => {
  for (const flag of EXPERIMENTAL_FLAGS) {
    assert.ok(flag.description.length > 0, `${flag.name} has an empty description`);
  }
});

// ---------------------------------------------------------------------------
// Default state
// ---------------------------------------------------------------------------

test(
  "experimental: returns false by default for every registered flag",
  withClean(() => {
    for (const flag of EXPERIMENTAL_FLAGS) {
      assert.equal(experimental(flag.name), false, `${flag.name} should default to off`);
    }
  }),
);

test(
  "experimental: returns false for unknown flag names",
  withClean(() => {
    assert.equal(experimental("UNKNOWN_FLAG"), false);
  }),
);

// ---------------------------------------------------------------------------
// Env-var overrides
// ---------------------------------------------------------------------------

test(
  "experimental: per-feature env var BAKUDO_EXPERIMENTAL_<NAME>=1 enables the flag",
  withClean(() => {
    process.env["BAKUDO_EXPERIMENTAL_QUICK_SEARCH"] = "1";
    assert.equal(experimental("QUICK_SEARCH"), true);
    // Other flags untouched.
    assert.equal(experimental("RICH_TUI"), false);
  }),
);

test(
  "experimental: per-feature env var accepts 1/true/on/yes (case-insensitive)",
  withClean(() => {
    for (const truthy of ["1", "true", "TRUE", "on", "Yes"]) {
      process.env["BAKUDO_EXPERIMENTAL_QUICK_SEARCH"] = truthy;
      assert.equal(experimental("QUICK_SEARCH"), true, `expected '${truthy}' to enable the flag`);
    }
  }),
);

test(
  "experimental: per-feature env var 0/false/off disables the flag (overrides cluster)",
  withClean(() => {
    process.env["BAKUDO_EXPERIMENTAL"] = "all";
    process.env["BAKUDO_EXPERIMENTAL_QUICK_SEARCH"] = "0";
    // Per-feature override must beat the cluster env var.
    assert.equal(experimental("QUICK_SEARCH"), false);
    assert.equal(experimental("RICH_TUI"), true);
  }),
);

test(
  "experimental: BAKUDO_EXPERIMENTAL=all enables every registered flag",
  withClean(() => {
    process.env["BAKUDO_EXPERIMENTAL"] = "all";
    for (const flag of EXPERIMENTAL_FLAGS) {
      assert.equal(experimental(flag.name), true, `${flag.name} should be on under =all`);
    }
  }),
);

test(
  "experimental: BAKUDO_EXPERIMENTAL with unknown value does not enable the cluster",
  withClean(() => {
    process.env["BAKUDO_EXPERIMENTAL"] = "sometimes";
    assert.equal(experimental("QUICK_SEARCH"), false);
  }),
);

// ---------------------------------------------------------------------------
// Config layer
// ---------------------------------------------------------------------------

test(
  "experimental: merged config bare boolean `true` turns on the cluster",
  withClean(() => {
    setExperimentalConfigResolver(() => true);
    for (const flag of EXPERIMENTAL_FLAGS) {
      assert.equal(experimental(flag.name), true);
    }
  }),
);

test(
  "experimental: merged config bare boolean `false` leaves every flag off",
  withClean(() => {
    setExperimentalConfigResolver(() => false);
    for (const flag of EXPERIMENTAL_FLAGS) {
      assert.equal(experimental(flag.name), false);
    }
  }),
);

test(
  "experimental: config record toggles a single flag independently",
  withClean(() => {
    setExperimentalConfigResolver(() => ({ QUICK_SEARCH: true }));
    assert.equal(experimental("QUICK_SEARCH"), true);
    assert.equal(experimental("RICH_TUI"), false);
  }),
);

test(
  "experimental: config record `{ all: true }` acts as a cluster toggle",
  withClean(() => {
    setExperimentalConfigResolver(() => ({ all: true }));
    for (const flag of EXPERIMENTAL_FLAGS) {
      assert.equal(experimental(flag.name), true);
    }
  }),
);

// ---------------------------------------------------------------------------
// Priority / late-binding
// ---------------------------------------------------------------------------

test(
  "experimental: env var wins over config record (override-at-access-site)",
  withClean(() => {
    setExperimentalConfigResolver(() => ({ QUICK_SEARCH: false }));
    process.env["BAKUDO_EXPERIMENTAL_QUICK_SEARCH"] = "1";
    assert.equal(experimental("QUICK_SEARCH"), true);
  }),
);

test(
  "experimental: late-binding — setting an env var after import still takes effect",
  withClean(() => {
    assert.equal(experimental("QUICK_SEARCH"), false);
    process.env["BAKUDO_EXPERIMENTAL_QUICK_SEARCH"] = "1";
    assert.equal(experimental("QUICK_SEARCH"), true);
    delete process.env["BAKUDO_EXPERIMENTAL_QUICK_SEARCH"];
    assert.equal(experimental("QUICK_SEARCH"), false);
  }),
);

test(
  "experimental: --experimental session override enables the cluster without config",
  withClean(() => {
    assert.equal(experimental("QUICK_SEARCH"), false);
    setSessionExperimentalCluster(true);
    for (const flag of EXPERIMENTAL_FLAGS) {
      assert.equal(experimental(flag.name), true);
    }
    resetSessionExperimentalCluster();
    assert.equal(experimental("QUICK_SEARCH"), false);
  }),
);

test(
  "experimental: per-feature env `off` beats the session --experimental cluster",
  withClean(() => {
    setSessionExperimentalCluster(true);
    process.env["BAKUDO_EXPERIMENTAL_QUICK_SEARCH"] = "0";
    assert.equal(experimental("QUICK_SEARCH"), false);
    assert.equal(experimental("RICH_TUI"), true);
  }),
);

// ---------------------------------------------------------------------------
// Summary helper
// ---------------------------------------------------------------------------

test(
  "summarizeExperimentalFlags: returns one entry per registered flag with its state",
  withClean(() => {
    process.env["BAKUDO_EXPERIMENTAL_QUICK_SEARCH"] = "1";
    const summary = summarizeExperimentalFlags();
    assert.equal(summary.length, EXPERIMENTAL_FLAGS.length);
    const quick = summary.find((s) => s.name === "QUICK_SEARCH");
    assert.ok(quick);
    assert.equal(quick.enabled, true);
    const rich = summary.find((s) => s.name === "RICH_TUI");
    assert.ok(rich);
    assert.equal(rich.enabled, false);
  }),
);

test(
  "summarizeExperimentalFlags: reflects config resolver when no env vars set",
  withClean(() => {
    setExperimentalConfigResolver(() => ({ RICH_TUI: true }));
    const summary = summarizeExperimentalFlags();
    const rich = summary.find((s) => s.name === "RICH_TUI");
    assert.ok(rich);
    assert.equal(rich.enabled, true);
    const quick = summary.find((s) => s.name === "QUICK_SEARCH");
    assert.ok(quick);
    assert.equal(quick.enabled, false);
  }),
);
