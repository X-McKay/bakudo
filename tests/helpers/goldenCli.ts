/**
 * Phase 6 Workstream 10 (PR15) — CLI wrapper for explicit golden ops.
 *
 * Usage:
 *   node dist/tests/helpers/goldenCli.js --test-only    # default: no-op
 *   node dist/tests/helpers/goldenCli.js --regenerate   # explicit update
 *
 * `--regenerate` currently round-trips each fixture through encode/decode
 * to exercise the path and confirm literal/byte parity. A future PR that
 * wires `runUnderPty` against a real bakudo CLI invocation will replace
 * the trivial round-trip with captured bytes.
 *
 * Never wire this into CI — fixture updates must be developer-gated
 * per plan line 588 + 738.
 */

import { FIXTURE_IDS, loadFixture, regenerateFixture } from "./golden.js";

const runtimeProcess = (
  globalThis as unknown as {
    process: {
      argv: string[];
      env: Record<string, string | undefined>;
      stdout: { write(data: string): void };
      stderr: { write(data: string): void };
      exit(code: number): void;
    };
  }
).process;

type Mode = "test-only" | "regenerate";

const parseMode = (argv: string[]): Mode => {
  const rest = argv.slice(2);
  if (rest.includes("--regenerate")) return "regenerate";
  if (rest.includes("--test-only") || rest.length === 0) return "test-only";
  runtimeProcess.stderr.write(`unknown args: ${rest.join(" ")}\n`);
  runtimeProcess.stderr.write(`usage: goldenCli [--test-only | --regenerate]\n`);
  runtimeProcess.exit(2);
  return "test-only";
};

const main = async (): Promise<number> => {
  const mode = parseMode(runtimeProcess.argv);
  runtimeProcess.stdout.write(`golden cli: mode=${mode}\n`);
  if (mode === "test-only") {
    runtimeProcess.stdout.write(
      "no-op. Run `mise run test` to verify; pass BAKUDO_GOLDEN_REGENERATE=1 to update.\n",
    );
    return 0;
  }
  for (const id of FIXTURE_IDS) {
    const fixture = await loadFixture(id);
    await regenerateFixture(fixture, fixture.bytes);
    runtimeProcess.stdout.write(`  regenerated: ${id}\n`);
  }
  return 0;
};

main().then(
  (code) => runtimeProcess.exit(code),
  (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    runtimeProcess.stderr.write(`golden cli failed: ${message}\n`);
    runtimeProcess.exit(1);
  },
);
