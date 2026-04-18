/**
 * Argv parser for the Copilot-parity flag namespace (Phase 5 PR11).
 *
 * Split out of `src/host/parsing.ts` to keep that file under the 400-line
 * cap. {@link tryConsumeCopilotFlag} returns the number of argv slots it
 * consumed, or `0` when the current slot is not a Copilot-parity flag.
 */

import {
  DEFAULT_MAX_AUTOPILOT_CONTINUES,
  readLongFlag,
  parsePositiveInteger,
  type CopilotParityFlags,
} from "./parsing.js";

type ConsumeResult = { consumed: number };

/**
 * Attempt to consume one Copilot-parity flag starting at `argv[i]`.
 * Returns `{ consumed: 0 }` if the argv slot is not a Copilot flag (the
 * caller then falls through to the next parser). Otherwise mutates
 * `flags` in place and returns the number of argv slots consumed.
 *
 * The function is a pure function of `(argv, i, flags)` plus throws for
 * malformed values — no global state.
 */
export const tryConsumeCopilotFlag = (
  argv: string[],
  i: number,
  flags: CopilotParityFlags,
): ConsumeResult => {
  const arg = argv[i];
  if (arg === undefined) {
    return { consumed: 0 };
  }

  // `-p` / `--prompt` — one-shot goal.
  if (arg === "-p" || arg === "--prompt" || arg.startsWith("--prompt=")) {
    if (arg === "-p") {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new Error("missing value for -p");
      }
      flags.prompt = next;
      return { consumed: 2 };
    }
    const { value, consumed } = readLongFlag(argv, i, "--prompt");
    flags.prompt = value;
    return { consumed };
  }

  // `--stream=on|off` — buffered vs live.
  if (arg === "--stream" || arg.startsWith("--stream=")) {
    const { value, consumed } = readLongFlag(argv, i, "--stream");
    if (value !== "on" && value !== "off") {
      throw new Error("invalid --stream: expected on or off");
    }
    flags.streamOff = value === "off";
    return { consumed };
  }

  // `--plain-diff` — ANSI strip for diff-kind artifacts.
  if (arg === "--plain-diff") {
    flags.plainDiff = true;
    return { consumed: 1 };
  }

  // `--json` — short alias for `--output-format=json`.
  if (arg === "--json") {
    flags.outputFormat = "json";
    return { consumed: 1 };
  }

  // `--output-format=json|text` — machine-readable stream.
  if (arg === "--output-format" || arg.startsWith("--output-format=")) {
    const { value, consumed } = readLongFlag(argv, i, "--output-format");
    if (value !== "json" && value !== "text") {
      throw new Error("invalid --output-format: expected json or text");
    }
    flags.outputFormat = value;
    return { consumed };
  }

  // `--allow-all-tools` — force Autopilot mode.
  if (arg === "--allow-all-tools") {
    flags.allowAllTools = true;
    return { consumed: 1 };
  }

  // `--no-ask-user` — non-interactive approval gate.
  if (arg === "--no-ask-user") {
    flags.noAskUser = true;
    return { consumed: 1 };
  }

  // `--max-autopilot-continues=N` — bakudo-original cap.
  if (arg === "--max-autopilot-continues" || arg.startsWith("--max-autopilot-continues=")) {
    const { value, consumed } = readLongFlag(argv, i, "--max-autopilot-continues");
    flags.maxAutopilotContinues = parsePositiveInteger(
      value,
      "--max-autopilot-continues",
      DEFAULT_MAX_AUTOPILOT_CONTINUES,
    );
    return { consumed };
  }

  return { consumed: 0 };
};
