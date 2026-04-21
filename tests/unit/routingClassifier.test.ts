import test from "node:test";
import assert from "node:assert/strict";
import { classifyGoal } from "../../src/host/orchestration/routingClassifier.js";

// ---------------------------------------------------------------------------
// Simple paths
// ---------------------------------------------------------------------------

test("classifyGoal: empty string is simple", () => {
  assert.equal(classifyGoal(""), "simple");
});

test("classifyGoal: whitespace-only string is simple", () => {
  assert.equal(classifyGoal("   "), "simple");
});

test("classifyGoal: slash command is always simple", () => {
  assert.equal(classifyGoal("/help"), "simple");
  assert.equal(classifyGoal("/version"), "simple");
  assert.equal(classifyGoal("/sessions"), "simple");
});

test("classifyGoal: short question starting with 'what' is simple", () => {
  assert.equal(classifyGoal("what is the current branch?"), "simple");
});

test("classifyGoal: short question starting with 'how' is simple", () => {
  assert.equal(classifyGoal("how do I run tests?"), "simple");
});

test("classifyGoal: short question starting with 'explain' is simple", () => {
  assert.equal(classifyGoal("explain the reducer"), "simple");
});

test("classifyGoal: 'show me' prefix is simple", () => {
  assert.equal(classifyGoal("show me the logs"), "simple");
});

test("classifyGoal: 'list' prefix is simple", () => {
  assert.equal(classifyGoal("list all sessions"), "simple");
});

test("classifyGoal: 'find' prefix is simple", () => {
  assert.equal(classifyGoal("find the config file"), "simple");
});

test("classifyGoal: 'check' prefix is simple", () => {
  assert.equal(classifyGoal("check the build status"), "simple");
});

test("classifyGoal: 'read' prefix is simple", () => {
  assert.equal(classifyGoal("read src/host/appState.ts"), "simple");
});

test("classifyGoal: 'open' prefix is simple", () => {
  assert.equal(classifyGoal("open the README"), "simple");
});

test("classifyGoal: 'is' prefix is simple", () => {
  assert.equal(classifyGoal("is the build passing?"), "simple");
});

test("classifyGoal: 'does' prefix is simple", () => {
  assert.equal(classifyGoal("does the reducer handle toggle_sidebar?"), "simple");
});

test("classifyGoal: 'can you' prefix is simple", () => {
  assert.equal(classifyGoal("can you show me the diff?"), "simple");
});

test("classifyGoal: 'summarize' prefix is simple", () => {
  assert.equal(classifyGoal("summarize the last session"), "simple");
});

// ---------------------------------------------------------------------------
// Complex paths — keyword triggers
// ---------------------------------------------------------------------------

test("classifyGoal: 'refactor' keyword is complex", () => {
  assert.equal(classifyGoal("refactor the reducer into smaller files"), "complex");
});

test("classifyGoal: 'implement' keyword is complex", () => {
  assert.equal(classifyGoal("implement the new approval dialog"), "complex");
});

test("classifyGoal: 'add tests' keyword is complex", () => {
  assert.equal(classifyGoal("add tests for the routing classifier"), "complex");
});

test("classifyGoal: 'write tests' keyword is complex", () => {
  assert.equal(classifyGoal("write tests for all orchestration modules"), "complex");
});

test("classifyGoal: 'migrate' keyword is complex", () => {
  assert.equal(classifyGoal("migrate the session store to the new schema"), "complex");
});

test("classifyGoal: 'redesign' keyword is complex", () => {
  assert.equal(classifyGoal("redesign the sidebar layout"), "complex");
});

test("classifyGoal: 'rewrite' keyword is complex", () => {
  assert.equal(classifyGoal("rewrite the planner module"), "complex");
});

test("classifyGoal: 'create a' keyword is complex", () => {
  assert.equal(classifyGoal("create a new command for the registry"), "complex");
});

test("classifyGoal: 'build a' keyword is complex", () => {
  assert.equal(classifyGoal("build a dashboard for the metrics"), "complex");
});

test("classifyGoal: 'set up' keyword is complex", () => {
  assert.equal(classifyGoal("set up the CI pipeline"), "complex");
});

test("classifyGoal: 'integrate' keyword is complex", () => {
  assert.equal(classifyGoal("integrate the new provider into the registry"), "complex");
});

test("classifyGoal: 'extract' keyword is complex", () => {
  assert.equal(classifyGoal("extract the approval logic into its own module"), "complex");
});

test("classifyGoal: 'split' keyword is complex", () => {
  assert.equal(classifyGoal("split the large reducer into smaller slices"), "complex");
});

test("classifyGoal: 'consolidate' keyword is complex", () => {
  assert.equal(classifyGoal("consolidate all config loading into one place"), "complex");
});

// ---------------------------------------------------------------------------
// Complex paths — length trigger (≥ 60 chars, no simple-question pattern)
// ---------------------------------------------------------------------------

test("classifyGoal: long input without simple-question prefix is complex", () => {
  const longGoal =
    "Update the session store to use the new schema and add migration logic for existing records";
  assert.ok(longGoal.length >= 60);
  assert.equal(classifyGoal(longGoal), "complex");
});

test("classifyGoal: long question starting with 'what' is still simple", () => {
  const longQuestion =
    "what is the purpose of the session store and how does it relate to the timeline module?";
  assert.ok(longQuestion.length >= 60);
  assert.equal(classifyGoal(longQuestion), "simple");
});

test("classifyGoal: long question starting with 'how' is still simple", () => {
  const longQuestion =
    "how does the approval dialog cursor cycle through the four options in the reducer?";
  assert.ok(longQuestion.length >= 60);
  assert.equal(classifyGoal(longQuestion), "simple");
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

test("classifyGoal: exactly 59 chars without keywords is simple", () => {
  // 59 chars, no keyword, no simple-question pattern
  const text = "update the config file to use the new provider format here";
  assert.ok(text.length < 60);
  // 'update' is not in the keyword list, so this should be simple
  assert.equal(classifyGoal(text), "simple");
});

test("classifyGoal: case-insensitive keyword matching", () => {
  assert.equal(classifyGoal("REFACTOR the session store"), "complex");
  assert.equal(classifyGoal("Implement a new command"), "complex");
});

test("classifyGoal: simple-question pattern overrides length", () => {
  const text = "explain the full lifecycle of an attempt from creation to completion in the system";
  assert.ok(text.length >= 60);
  assert.equal(classifyGoal(text), "simple");
});
