import assert from "node:assert/strict";
import test from "node:test";

import { parseWorktreePorcelain } from "../../src/host/worktreeDiscovery.js";

test("parseWorktreePorcelain returns matching snapshot for expected branch", () => {
  const output = [
    "worktree /repo",
    "HEAD aaaaa",
    "branch refs/heads/main",
    "",
    "worktree /repo/.git/worktrees/bakudo-attempt",
    "HEAD bbbbb",
    "branch refs/heads/agent/bakudo-attempt-1",
    "",
  ].join("\n");
  const found = parseWorktreePorcelain(output, "refs/heads/agent/bakudo-attempt-1");
  assert.deepEqual(found, {
    path: "/repo/.git/worktrees/bakudo-attempt",
    branch: "refs/heads/agent/bakudo-attempt-1",
    head: "bbbbb",
  });
});

test("parseWorktreePorcelain returns null when branch is absent", () => {
  const output = ["worktree /repo", "HEAD aaaaa", "branch refs/heads/main", ""].join("\n");
  const found = parseWorktreePorcelain(output, "refs/heads/agent/missing");
  assert.equal(found, null);
});
