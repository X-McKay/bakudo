import assert from "node:assert/strict";
import test from "node:test";

import { runThemeCommand } from "../../../src/host/commands/system.js";
import {
  getActiveThemeVariant,
  resetActiveTheme,
  setActiveTheme,
} from "../../../src/host/themes/index.js";

const collect = (): { print: (line: string) => void; lines: string[] } => {
  const lines: string[] = [];
  return { lines, print: (line) => lines.push(line) };
};

test("/theme show reports the current active variant", () => {
  resetActiveTheme();
  const sink = collect();
  runThemeCommand({ args: ["show"], print: sink.print });
  assert.equal(sink.lines.length, 1);
  assert.match(sink.lines[0] ?? "", /active variant is "dark"/);
});

test("/theme (no args) defaults to show", () => {
  resetActiveTheme();
  const sink = collect();
  runThemeCommand({ args: [], print: sink.print });
  assert.equal(sink.lines.length, 1);
  assert.match(sink.lines[0] ?? "", /active variant is "dark"/);
});

test("/theme set <variant> mutates the active theme singleton", () => {
  resetActiveTheme();
  const sink = collect();
  runThemeCommand({ args: ["set", "light-daltonized"], print: sink.print });
  assert.equal(getActiveThemeVariant(), "light-daltonized");
  assert.match(sink.lines[0] ?? "", /active variant is now "light-daltonized"/);
  resetActiveTheme();
});

test("/theme set <unknown> prints an error and does NOT mutate the singleton", () => {
  resetActiveTheme();
  setActiveTheme("dark");
  const sink = collect();
  runThemeCommand({ args: ["set", "bogus-theme"], print: sink.print });
  assert.equal(getActiveThemeVariant(), "dark", "singleton unchanged on invalid variant");
  const joined = sink.lines.join("\n");
  assert.match(joined, /unknown variant/);
});

test("/theme set (missing variant) prints usage", () => {
  resetActiveTheme();
  const sink = collect();
  runThemeCommand({ args: ["set"], print: sink.print });
  const joined = sink.lines.join("\n");
  assert.match(joined, /missing variant/);
  assert.match(joined, /\/theme set <variant>/);
});

test("/theme unknown-subcommand prints usage", () => {
  resetActiveTheme();
  const sink = collect();
  runThemeCommand({ args: ["nonsense"], print: sink.print });
  const joined = sink.lines.join("\n");
  assert.match(joined, /Unknown \/theme subcommand/);
});
