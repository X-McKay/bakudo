import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { render } from "ink-testing-library";
import { Spinner } from "../../../../../src/host/renderers/ink/Spinner.js";

test("Spinner: renders a Braille frame character", () => {
  const { lastFrame } = render(<Spinner />);
  const frame = lastFrame() ?? "";
  assert.match(frame, /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
});
