/**
 * Phase 6 Workstream 10 (PR15) — Golden fixture comparator.
 *
 * Loads the 14 canonical fixtures from `plans/bakudo-ux/examples/` and
 * compares them against output captured by `./ptyHarness.ts`.
 *
 * Fixture-byte-direction: fixtures use LITERAL `\e[1m` escapes for
 * reviewer readability (`plans/bakudo-ux/examples/README.md:138-140`).
 * This module decodes literal → byte bytes on LOAD so the canonical
 * compare form is the raw PTY byte stream. On mismatch, diffs render
 * back to literal form for human review (plan line 611).
 *
 * Regeneration is explicit only: set `BAKUDO_GOLDEN_REGENERATE=1` or
 * run the `goldenCli.ts` wrapper with `--regenerate`. Normal runs
 * never mutate fixtures (plan lines 588 + 738).
 */

import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const runtimeProcess = (
  globalThis as unknown as {
    process: { env: Record<string, string | undefined> };
  }
).process;

export type FixtureId =
  | "empty-shell.tty.txt"
  | "empty-shell.plain.txt"
  | "first-prompt-new-session.tty.txt"
  | "follow-up-turn.tty.txt"
  | "approval-prompt-shell-git.tty.txt"
  | "approval-prompt-network.tty.txt"
  | "inspect-summary.tty.txt"
  | "inspect-provenance.tty.txt"
  | "inspect-retry-lineage.tty.txt"
  | "autopilot-run.plain.txt"
  | "protocol-mismatch-error.plain.txt"
  | "json-mode-session-events.jsonl"
  | "json-mode-error-envelope.json"
  | "doctor-output.json";

export const FIXTURE_IDS: readonly FixtureId[] = [
  "empty-shell.tty.txt",
  "empty-shell.plain.txt",
  "first-prompt-new-session.tty.txt",
  "follow-up-turn.tty.txt",
  "approval-prompt-shell-git.tty.txt",
  "approval-prompt-network.tty.txt",
  "inspect-summary.tty.txt",
  "inspect-provenance.tty.txt",
  "inspect-retry-lineage.tty.txt",
  "autopilot-run.plain.txt",
  "protocol-mismatch-error.plain.txt",
  "json-mode-session-events.jsonl",
  "json-mode-error-envelope.json",
  "doctor-output.json",
] as const;

export const STABLE_TIMESTAMP = "1970-01-01T00:00:00.000Z";
export const STABLE_SESSION_ID = "ses_deterministic_0000000000";
export const STABLE_TURN_ID = "turn_deterministic_00000000000";
export const STABLE_ATTEMPT_ID = "attempt_deterministic_00000000";
export const STABLE_EVENT_ID = "evt_deterministic_0000000000";
export const STABLE_APPROVAL_ID = "apr_deterministic_0000000000";
export const STABLE_ARTIFACT_ID = "art_deterministic_0000000000";

/**
 * Walk up from the compiled test file location until the parent workspace
 * `plans/bakudo-ux/examples/` directory is located.
 */
export const locateExamplesDir = async (): Promise<string | null> => {
  const here = dirname(fileURLToPath(import.meta.url));
  let dir = here;
  for (let i = 0; i < 12; i += 1) {
    const candidate = resolve(dir, "plans", "bakudo-ux", "examples");
    try {
      const probe = await readFile(resolve(candidate, "README.md"), "utf8");
      if (probe.includes("Bakudo UX Golden Fixtures")) {
        return candidate;
      }
    } catch {
      // keep walking
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
};

/**
 * Strip the leading `# …` comment block. Blank lines inside the preamble
 * are kept; only lines that start with `#` are dropped. Body starts with
 * the first non-comment, non-blank line.
 */
export const stripFixtureComments = (raw: string): string => {
  const lines = raw.split("\n");
  let start = 0;
  while (start < lines.length) {
    const line = lines[start] ?? "";
    if (line.startsWith("#") || line.trim() === "") {
      start += 1;
      continue;
    }
    break;
  }
  return lines.slice(start).join("\n");
};

/**
 * Decode literal escape markers used by fixtures into real control bytes.
 * Supports `\e`, `\n`, `\r`, `\t`, `\\`, and `\uXXXX`.
 */
export const decodeLiteralEscapes = (text: string): string => {
  return text
    .replace(/\\u([0-9a-fA-F]{4})/gu, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\e/gu, "\u001B")
    .replace(/\\n/gu, "\n")
    .replace(/\\r/gu, "\r")
    .replace(/\\t/gu, "\t")
    .replace(/\\\\/gu, "\\");
};

/**
 * Re-render control bytes back to the fixtures' literal form for diffs.
 *
 * Intentionally NOT a bijective inverse of {@link decodeLiteralEscapes}:
 * `\n` and `\uXXXX` sequences decode on load but are NOT re-encoded here —
 * newlines stay as real bytes so multi-line diffs remain readable. The
 * asymmetry is a readability-over-round-trip-fidelity choice. Fixture
 * authors who add literal `\n` or `\uXXXX` should be aware the characters
 * are silently collapsed on regeneration.
 */
export const encodeLiteralEscapes = (bytes: string): string => {
  return bytes
    .replace(/\\/gu, "\\\\")
    .replace(/\u001B/gu, "\\e")
    .replace(/\t/gu, "\\t")
    .replace(/\r/gu, "\\r");
};

/**
 * Normalize dynamic fields before diff. Applied symmetrically to both
 * fixture and captured output (plan lines 586–587).
 */
export const normalizeDynamicFields = (text: string): string => {
  return text
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/gu, STABLE_TIMESTAMP)
    .replace(/evt_[A-Z0-9]{4,}/gu, STABLE_EVENT_ID)
    .replace(/ses_[A-Z0-9]{4,}/gu, STABLE_SESSION_ID)
    .replace(/turn_[A-Z0-9]{4,}/gu, STABLE_TURN_ID)
    .replace(/attempt_[A-Z0-9]{4,}/gu, STABLE_ATTEMPT_ID)
    .replace(/apr_[A-Z0-9]{4,}/gu, STABLE_APPROVAL_ID)
    .replace(/art_[A-Z0-9]{4,}/gu, STABLE_ARTIFACT_ID);
};

export type LoadedFixture = {
  id: FixtureId;
  absolutePath: string;
  raw: string;
  body: string;
  /** Canonical byte form. For `.tty.txt`: literal escapes decoded. */
  bytes: string;
};

export const loadFixture = async (id: FixtureId): Promise<LoadedFixture> => {
  const dir = await locateExamplesDir();
  if (dir === null) {
    throw new Error("could not locate plans/bakudo-ux/examples directory");
  }
  const absolutePath = resolve(dir, id);
  const raw = await readFile(absolutePath, "utf8");
  const body = stripFixtureComments(raw);
  const isTty = id.endsWith(".tty.txt");
  const bytes = isTty ? decodeLiteralEscapes(body) : body;
  return { id, absolutePath, raw, body, bytes };
};

export type DiffResult =
  | { kind: "equal" }
  | {
      kind: "mismatch";
      expectedLiteral: string;
      actualLiteral: string;
      /**
       * Byte index into the NORMALIZED DECODED form (before
       * `encodeLiteralEscapes` runs for the `*Literal` fields). Does not
       * point into `expectedLiteral`/`actualLiteral` — those are re-encoded.
       */
      firstDivergenceByteIndexInDecodedForm: number;
    };

export const diffAgainstFixture = (fixture: LoadedFixture, capturedBytes: string): DiffResult => {
  const expected = normalizeDynamicFields(fixture.bytes);
  const actual = normalizeDynamicFields(capturedBytes);
  if (expected === actual) {
    return { kind: "equal" };
  }
  let i = 0;
  const limit = Math.min(expected.length, actual.length);
  while (i < limit && expected[i] === actual[i]) {
    i += 1;
  }
  return {
    kind: "mismatch",
    expectedLiteral: encodeLiteralEscapes(expected),
    actualLiteral: encodeLiteralEscapes(actual),
    firstDivergenceByteIndexInDecodedForm: i,
  };
};

/**
 * Regenerate a fixture on disk. Only called under explicit opt-in.
 */
export const regenerateFixture = async (
  fixture: LoadedFixture,
  capturedBytes: string,
): Promise<void> => {
  const isTty = fixture.id.endsWith(".tty.txt");
  const body = isTty ? encodeLiteralEscapes(capturedBytes) : capturedBytes;
  const preambleEnd = fixture.raw.length - fixture.body.length;
  const preamble = fixture.raw.slice(0, preambleEnd);
  await writeFile(fixture.absolutePath, preamble + body, "utf8");
};

export const regenerationRequested = (): boolean => {
  return runtimeProcess.env.BAKUDO_GOLDEN_REGENERATE === "1";
};
