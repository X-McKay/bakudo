import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parseTokenBudget } from "../../src/host/tokenBudget.js";

describe("parseTokenBudget", () => {
  it("+500k prefix → 500_000, prompt starts clean", () => {
    const result = parseTokenBudget("+500k fix the bug");
    assert.notEqual(result.budget, null);
    assert.equal(result.budget!.tokens, 500_000);
    assert.equal(result.budget!.raw, "+500k");
    assert.equal(result.cleanedPrompt, "fix the bug");
  });

  it("... +500k. suffix → 500_000, trailing period stripped", () => {
    const result = parseTokenBudget("fix the bug +500k.");
    assert.notEqual(result.budget, null);
    assert.equal(result.budget!.tokens, 500_000);
    assert.equal(result.budget!.raw, "+500k");
    assert.equal(result.cleanedPrompt, "fix the bug");
  });

  it("spend 2M tokens on refactor → 2_000_000", () => {
    const result = parseTokenBudget("spend 2M tokens on refactor");
    assert.notEqual(result.budget, null);
    assert.equal(result.budget!.tokens, 2_000_000);
    assert.equal(result.budget!.raw, "spend 2M tokens");
    assert.equal(result.cleanedPrompt, "on refactor");
  });

  it("+1.5m → 1_500_000 (decimal support)", () => {
    const result = parseTokenBudget("+1.5m do something");
    assert.notEqual(result.budget, null);
    assert.equal(result.budget!.tokens, 1_500_000);
    assert.equal(result.cleanedPrompt, "do something");
  });

  it("no budget → null, prompt unchanged", () => {
    const result = parseTokenBudget("just a normal prompt");
    assert.equal(result.budget, null);
    assert.equal(result.cleanedPrompt, "just a normal prompt");
  });

  it("multiple patterns → first match wins (prefix over suffix)", () => {
    const result = parseTokenBudget("+100k something +200k");
    assert.notEqual(result.budget, null);
    // Prefix pattern matches first.
    assert.equal(result.budget!.tokens, 100_000);
    assert.equal(result.cleanedPrompt, "something +200k");
  });

  it("case insensitive: +500K = +500k", () => {
    const result = parseTokenBudget("+500K refactor");
    assert.notEqual(result.budget, null);
    assert.equal(result.budget!.tokens, 500_000);
  });

  it("case insensitive: +2M = +2m", () => {
    const result = parseTokenBudget("+2M refactor");
    assert.notEqual(result.budget, null);
    assert.equal(result.budget!.tokens, 2_000_000);
  });

  it("edge: +0k → 0 (allowed)", () => {
    const result = parseTokenBudget("+0k something");
    assert.notEqual(result.budget, null);
    assert.equal(result.budget!.tokens, 0);
    assert.equal(result.cleanedPrompt, "something");
  });

  it("edge: +999b → 999_000_000_000", () => {
    const result = parseTokenBudget("+999b huge task");
    assert.notEqual(result.budget, null);
    assert.equal(result.budget!.tokens, 999_000_000_000);
  });

  it("spend with singular token", () => {
    const result = parseTokenBudget("spend 1m token on cleanup");
    assert.notEqual(result.budget, null);
    assert.equal(result.budget!.tokens, 1_000_000);
    assert.equal(result.cleanedPrompt, "on cleanup");
  });

  it("suffix without trailing period", () => {
    const result = parseTokenBudget("refactor the module +250k");
    assert.notEqual(result.budget, null);
    assert.equal(result.budget!.tokens, 250_000);
    assert.equal(result.cleanedPrompt, "refactor the module");
  });

  it("verbose pattern in the middle of prompt", () => {
    const result = parseTokenBudget("please spend 500k tokens on this refactoring");
    assert.notEqual(result.budget, null);
    assert.equal(result.budget!.tokens, 500_000);
    assert.equal(result.cleanedPrompt, "please on this refactoring");
  });

  it("plain number without suffix is not a budget", () => {
    const result = parseTokenBudget("+500 fix the bug");
    assert.equal(result.budget, null);
    assert.equal(result.cleanedPrompt, "+500 fix the bug");
  });
});
