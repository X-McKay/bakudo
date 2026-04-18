import assert from "node:assert/strict";
import test from "node:test";

import {
  renderPermissionDisplayCommand,
  suggestAllowAlwaysPattern,
} from "../../src/host/approvalPolicy.js";

// ---------------------------------------------------------------------------
// renderPermissionDisplayCommand — drives the verbatim approval prompt copy
// ---------------------------------------------------------------------------

test("renderPermissionDisplayCommand composes tool(argument)", () => {
  assert.equal(
    renderPermissionDisplayCommand("shell", "git push origin main"),
    "shell(git push origin main)",
  );
  assert.equal(renderPermissionDisplayCommand("write", "src/foo.ts"), "write(src/foo.ts)");
  assert.equal(renderPermissionDisplayCommand("network", "https://x"), "network(https://x)");
});

// ---------------------------------------------------------------------------
// suggestAllowAlwaysPattern — shell
// ---------------------------------------------------------------------------

test("shell: generalises a git subcommand to `git <sub>:*`", () => {
  assert.equal(suggestAllowAlwaysPattern("shell", "git push origin main"), "git push:*");
  assert.equal(suggestAllowAlwaysPattern("shell", "git commit -m 'x'"), "git commit:*");
});

test("shell: generalises a non-git invocation to `<program>:*`", () => {
  assert.equal(suggestAllowAlwaysPattern("shell", "ls -la"), "ls:*");
  assert.equal(suggestAllowAlwaysPattern("shell", "npm install lodash"), "npm:*");
});

test("shell: empty argument falls back to *", () => {
  assert.equal(suggestAllowAlwaysPattern("shell", ""), "*");
  assert.equal(suggestAllowAlwaysPattern("shell", "   "), "*");
});

// ---------------------------------------------------------------------------
// suggestAllowAlwaysPattern — write / edit
// ---------------------------------------------------------------------------

test("write: generalises a path to its parent directory", () => {
  assert.equal(suggestAllowAlwaysPattern("write", "src/foo/bar.ts"), "src/foo/*");
  assert.equal(suggestAllowAlwaysPattern("write", "deep/nested/dir/file.js"), "deep/nested/dir/*");
});

test("write: a bare filename (no directory) falls back to *", () => {
  assert.equal(suggestAllowAlwaysPattern("write", "package.json"), "*");
});

test("edit behaves the same as write (shared path generalisation)", () => {
  assert.equal(suggestAllowAlwaysPattern("edit", "src/foo/bar.ts"), "src/foo/*");
  assert.equal(suggestAllowAlwaysPattern("edit", "README.md"), "*");
});

// ---------------------------------------------------------------------------
// suggestAllowAlwaysPattern — network
// ---------------------------------------------------------------------------

test("network: preserves scheme+host, wildcards the path", () => {
  assert.equal(
    suggestAllowAlwaysPattern("network", "https://api.github.com/repos/x/y"),
    "https://api.github.com/**",
  );
  assert.equal(
    suggestAllowAlwaysPattern("network", "http://internal.example/metrics"),
    "http://internal.example/**",
  );
});

test("network: scheme-less host is accepted and wildcarded", () => {
  assert.equal(suggestAllowAlwaysPattern("network", "api.example.com"), "api.example.com/**");
  assert.equal(
    suggestAllowAlwaysPattern("network", "api.example.com/v1/endpoint"),
    "api.example.com/**",
  );
});

// ---------------------------------------------------------------------------
// suggestAllowAlwaysPattern — unknown tools
// ---------------------------------------------------------------------------

test("unknown tool falls back to * (no assumptions)", () => {
  assert.equal(suggestAllowAlwaysPattern("task", "any-thing"), "*");
  assert.equal(suggestAllowAlwaysPattern("unknown-tool" as unknown as "task", "x"), "*");
});
