/**
 * Light/dark theme detection — three-stage cascade per plan
 * `05-rich-tui-and-distribution-hardening.md` §"Light/Dark Detection:
 * COLORFGBG + OSC 11 + Luminance" (lines 516-530).
 *
 * Resolution order (first match wins):
 *
 * 1. **Force-ANSI sentinel.** `NO_COLOR` env (https://no-color.org) or
 *    `BAKUDO_NO_COLOR` → force `*-ansi` variant (dark-ansi by default,
 *    light-ansi if `COLORFGBG` or OSC 11 says light).
 * 2. **User override.** `BAKUDO_THEME=<variant>` — explicit wins.
 * 3. **Synchronous `COLORFGBG` fast path.** `<fg>;<bg>` where `bg ∈ 0..15`;
 *    0-6 and 8 are dark ANSI colors, 7 and 9-15 are light.
 * 4. **Async OSC 11 round-trip.** Emit `\u001B]11;?\u001B\\` on stdout, read
 *    `rgb:RRRR/GGGG/BBBB` on stdin, compute ITU-R BT.709 luminance (`0.2126 r
 *    + 0.7152 g + 0.0722 b`), split at 0.5.
 * 5. **Fallback.** `dark` (best default for a terminal-oriented CLI).
 *
 * The async stages run behind a `timeoutMs` guard (default 100ms) so bakudo
 * doesn't hang against terminals that silently ignore the OSC query. Any
 * parse error or timeout falls through to the next stage.
 */
import type { ThemeVariant } from "./palette.js";
import { isThemeVariant } from "./palette.js";

export type DetectThemeOptions = {
  stdout?: NodeJS.WriteStream | undefined;
  stdin?: NodeJS.ReadStream | undefined;
  env?: Record<string, string | undefined>;
  timeoutMs?: number | undefined;
};

const DEFAULT_TIMEOUT_MS = 100;
const OSC_11_QUERY = "\u001B]11;?\u001B\\";

/** RGB triple with channels normalized to [0, 1]. */
export type NormalizedRgb = { r: number; g: number; b: number };

/**
 * Parse an OSC 11 color response payload (the part after `]11;`). Accepts
 * `rgb:RRRR/GGGG/BBBB` with 1-4 hex digits per channel (xterm, iTerm2,
 * Alacritty, kitty, Ghostty, etc.) and a trailing `rgba` alpha which is
 * ignored. Returns undefined on unrecognized input so the caller can fall
 * back to the next detection stage.
 */
export const parseOscRgb = (data: string): NormalizedRgb | undefined => {
  const match = /^rgba?:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})/i.exec(data.trim());
  if (!match) {
    return undefined;
  }
  const hexChannel = (hex: string): number => {
    const max = 16 ** hex.length - 1;
    return parseInt(hex, 16) / max;
  };
  return {
    r: hexChannel(match[1] ?? ""),
    g: hexChannel(match[2] ?? ""),
    b: hexChannel(match[3] ?? ""),
  };
};

/**
 * ITU-R BT.709 relative luminance. The formula is perceptually correct — a
 * naive `(r+g+b)/3` flips on cyan-on-black terminals like iTerm2's default.
 */
export const computeLuminance = (rgb: NormalizedRgb): number =>
  0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b;

/**
 * Resolve a COLORFGBG value (`<fg>;<bg>` or `<fg>;<other>;<bg>`) to a
 * "dark" / "light" signal. Returns undefined on malformed input.
 * Convention: `bg ∈ 0..6 ∪ {8}` is dark (black, red, green, yellow, blue,
 * magenta, cyan, and bright-black), `bg ∈ {7} ∪ 9..15` is light (white and
 * the bright variants). Matches rxvt and Konsole's convention.
 */
export const colorFgBgToTone = (value: string | undefined): "dark" | "light" | undefined => {
  if (!value) {
    return undefined;
  }
  const parts = value.split(";");
  // COLORFGBG must have at least `<fg>;<bg>` — 2 segments, possibly 3 when
  // the optional bright-color marker is present. A single-segment value is
  // not a valid COLORFGBG.
  if (parts.length < 2) {
    return undefined;
  }
  const bg = parts[parts.length - 1];
  if (bg === undefined || bg === "") {
    return undefined;
  }
  const bgNum = Number(bg);
  if (!Number.isInteger(bgNum) || bgNum < 0 || bgNum > 15) {
    return undefined;
  }
  return bgNum <= 6 || bgNum === 8 ? "dark" : "light";
};

/**
 * Issue the OSC 11 query and resolve once we see `rgb:…`, or undefined on
 * timeout / parse error. Intentionally forgiving: any read error, any
 * stdin that isn't a TTY, and any malformed reply just resolves undefined
 * so the caller can fall through to the next stage.
 */
export const queryTerminalBackgroundRgb = (
  stdout: NodeJS.WriteStream | undefined,
  stdin: NodeJS.ReadStream | undefined,
  timeoutMs: number,
): Promise<NormalizedRgb | undefined> =>
  new Promise((resolve) => {
    if (
      stdout === undefined ||
      stdin === undefined ||
      stdout.isTTY !== true ||
      stdin.isTTY !== true
    ) {
      resolve(undefined);
      return;
    }

    let buffer = "";
    let settled = false;
    const finish = (value: NormalizedRgb | undefined): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      stdin.off("data", onData);
      // Restore non-raw mode if we had to toggle it.
      if (toggledRawMode && typeof stdin.setRawMode === "function") {
        try {
          stdin.setRawMode(false);
        } catch {
          // setRawMode can throw if stdin was closed; swallow.
        }
      }
      resolve(value);
    };

    const onData = (chunk: Buffer | string): void => {
      buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      // OSC 11 reply shape: `\u001B]11;rgb:…<ST>` where <ST> is either BEL
      // (`\u0007`) or ESC-backslash (`\u001B\\`).
      const match = /\u001B\]11;([^\u0007\u001B]*)(?:\u0007|\u001B\\)/.exec(buffer);
      if (match) {
        finish(parseOscRgb(match[1] ?? ""));
      }
    };

    let toggledRawMode = false;
    try {
      if (typeof stdin.setRawMode === "function" && stdin.isRaw === false) {
        stdin.setRawMode(true);
        toggledRawMode = true;
      }
    } catch {
      // Some environments (CI TTYs, proxied shells) refuse setRawMode.
      // Fall through and hope the stdin reader behaves.
    }

    stdin.on("data", onData);
    const timer = setTimeout(() => finish(undefined), timeoutMs);

    try {
      stdout.write(OSC_11_QUERY);
    } catch {
      finish(undefined);
    }
  });

/**
 * Convert a tone + accessibility mode to a {@link ThemeVariant}. Pure helper
 * extracted so unit tests don't need to set up an entire detection pipeline.
 */
export const resolveVariant = (input: {
  tone: "dark" | "light";
  forceAnsi: boolean;
  daltonized: boolean;
}): ThemeVariant => {
  const suffix = input.forceAnsi ? "-ansi" : input.daltonized ? "-daltonized" : "";
  return `${input.tone}${suffix}` as ThemeVariant;
};

type GlobalProcess = {
  process?: {
    env?: Record<string, string | undefined>;
    stdout?: NodeJS.WriteStream;
    stdin?: NodeJS.ReadStream;
  };
};

/**
 * Resolve the active theme for this terminal session. Safe to call at
 * startup — honors user overrides, consults COLORFGBG synchronously, then
 * races an OSC 11 query against {@link DetectThemeOptions.timeoutMs}.
 */
export const detectTheme = async (options: DetectThemeOptions = {}): Promise<ThemeVariant> => {
  const runtime = (globalThis as GlobalProcess).process;
  const env = options.env ?? runtime?.env ?? {};
  const stdout = options.stdout ?? runtime?.stdout;
  const stdin = options.stdin ?? runtime?.stdin;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const forceAnsi =
    env["NO_COLOR"] !== undefined ||
    env["BAKUDO_NO_COLOR"] !== undefined ||
    env["BAKUDO_FORCE_ANSI"] !== undefined;
  const daltonized = env["BAKUDO_DALTONIZED"] !== undefined;

  // 1. Explicit user override — highest priority short of NO_COLOR's ANSI coercion.
  const override = env["BAKUDO_THEME"];
  if (override !== undefined && isThemeVariant(override)) {
    // NO_COLOR still forces ANSI: translate `dark` → `dark-ansi` etc.
    if (forceAnsi && !override.endsWith("-ansi")) {
      const tone = override.startsWith("light") ? "light" : "dark";
      return `${tone}-ansi`;
    }
    return override;
  }

  // 2. COLORFGBG synchronous path.
  const fromColorFgBg = colorFgBgToTone(env["COLORFGBG"]);
  if (fromColorFgBg !== undefined) {
    return resolveVariant({ tone: fromColorFgBg, forceAnsi, daltonized });
  }

  // 3. OSC 11 async round-trip. Best-effort; on timeout or parse failure,
  //    fall through to the dark-default fallback below.
  try {
    const rgb = await queryTerminalBackgroundRgb(stdout, stdin, timeoutMs);
    if (rgb !== undefined) {
      const tone = computeLuminance(rgb) > 0.5 ? "light" : "dark";
      return resolveVariant({ tone, forceAnsi, daltonized });
    }
  } catch {
    // Any exception falls through to the default.
  }

  // 4. Default. `dark-ansi` under NO_COLOR, else plain dark.
  return resolveVariant({ tone: "dark", forceAnsi, daltonized });
};
