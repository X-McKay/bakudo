import test from "node:test";
import assert from "node:assert/strict";

import { parseArgs } from "../../src/cli.js";

test("parseArgs uses the checked-in config path by default", () => {
  const args = parseArgs(["--goal", "echo hi"]);

  assert.equal(args.config, "config/default.json");
  assert.deepEqual(args.streams, ["default"]);
  assert.equal(args.aboxBin, "abox");
});

test("parseArgs accepts explicit overrides and repo passthrough", () => {
  const args = parseArgs([
    "--goal",
    "echo hi",
    "--config",
    "config/custom.json",
    "--abox-bin",
    "/usr/local/bin/abox",
    "--repo",
    "/tmp/repo",
    "--streams",
    "s1,,s2,",
  ]);

  assert.equal(args.config, "config/custom.json");
  assert.equal(args.aboxBin, "/usr/local/bin/abox");
  assert.equal(args.repo, "/tmp/repo");
  assert.deepEqual(args.streams, ["s1", "s2"]);
});

test("parseArgs ignores unknown flags and keeps known values intact", () => {
  const args = parseArgs(["--goal", "echo hi", "--mystery", "value", "--streams", "one"]);

  assert.equal(args.goal, "echo hi");
  assert.deepEqual(args.streams, ["one"]);
});

test("parseArgs converts an empty streams list to no streams", () => {
  const args = parseArgs(["--goal", "echo hi", "--streams", ""]);

  assert.deepEqual(args.streams, []);
});

test("parseArgs rejects missing goal", () => {
  assert.throws(() => parseArgs([]), /missing required argument --goal/);
});
