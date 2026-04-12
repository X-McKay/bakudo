import test from "node:test";
import assert from "node:assert/strict";

import { parseArgs } from "../../src/cli.js";

test("parseArgs uses the checked-in config path by default", () => {
  const args = parseArgs(["--goal", "echo hi"]);

  assert.equal(args.config, "config/default.json");
  assert.deepEqual(args.streams, ["default"]);
  assert.equal(args.aboxBin, "abox");
});

test("parseArgs accepts repo passthrough", () => {
  const args = parseArgs(["--goal", "echo hi", "--repo", "/tmp/repo", "--streams", "s1,s2"]);

  assert.equal(args.repo, "/tmp/repo");
  assert.deepEqual(args.streams, ["s1", "s2"]);
});
