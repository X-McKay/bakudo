import { createHash } from "node:crypto";
import { join } from "node:path";

import { z } from "zod";

import type { AttemptSpec } from "../attemptProtocol.js";
import type {
  ApplyResolutionConfidence,
  ApplyResolutionRecord,
} from "../sessionTypes.js";
import { reservedOutputRelativeDirForAttempt } from "./worktreeInspector.js";

type ConflictShape = {
  path: string;
  class: string;
  decision: string;
  reason: string;
  detail: string;
};

export type EligibleTextConflict = {
  path: string;
  conflict: ConflictShape;
  baseContent: string | null;
  candidateContent: string | null;
  sourceContent: string | null;
};

export type ApplyResolutionEligibility =
  | { eligible: true; reason: string }
  | { eligible: false; reason: string };

export type ApplyResolveResult = {
  path: string;
  resolvedContent: string | null;
  rationale: string;
  confidence: ApplyResolutionConfidence;
};

export type ApplyResolutionSuccess = {
  ok: true;
  value: ApplyResolveResult;
};

export type ApplyResolutionFailure = {
  ok: false;
  error: string;
};

export type ApplyResolutionParseResult = ApplyResolutionSuccess | ApplyResolutionFailure;

export type ApplyResolutionArtifactNames = {
  input: string;
  dispatch: string;
  result: string;
  output: string;
};

const MAX_AUTO_RESOLVE_BYTES = 40_000;
const MAX_AUTO_RESOLVE_LINES = 400;
const GENERATED_PATH_PATTERN =
  /(^|\/)(dist|build|coverage|generated|gen|vendor|node_modules|__snapshots__)(\/|$)/u;
const MINIFIED_FILE_PATTERN = /\.min\.[A-Za-z0-9]+$/u;
const ELIGIBLE_EXTENSION_PATTERN =
  /\.(c|cc|cpp|css|go|h|hpp|html|java|js|json|jsx|md|mjs|py|rb|rs|sh|sql|toml|ts|tsx|txt|yaml|yml)$/u;

const ApplyResolveResultSchema = z
  .object({
    path: z.string().min(1),
    resolvedContent: z.string().nullable(),
    rationale: z.string().min(1),
    confidence: z.enum(["high", "medium", "low"]),
  })
  .strict();

const countLines = (value: string | null): number => (value === null ? 0 : value.split("\n").length);

const safePathStem = (path: string): string =>
  path
    .replace(/[^A-Za-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .toLowerCase()
    .slice(0, 48) || "path";

const pathHash = (path: string): string =>
  createHash("sha256").update(path).digest("hex").slice(0, 10);

const truncateBlock = (value: string | null): string =>
  value === null ? "<missing>" : value.length > 20_000 ? `${value.slice(0, 20_000)}\n<trimmed>` : value;

export const artifactNamesForResolutionPath = (path: string): ApplyResolutionArtifactNames => {
  const stem = `${safePathStem(path)}-${pathHash(path)}`;
  return {
    input: `apply-resolve-${stem}-input.json`,
    dispatch: `apply-resolve-${stem}-dispatch.json`,
    result: `apply-resolve-${stem}-result.json`,
    output: `apply-resolve-${stem}-output.log`,
  };
};

export const resolveApplyResultPath = (workspaceRoot: string, attemptId: string): string =>
  join(workspaceRoot, reservedOutputRelativeDirForAttempt(attemptId), "result.json");

export const classifyConflictResolutionEligibility = (
  conflict: EligibleTextConflict,
): ApplyResolutionEligibility => {
  if (conflict.conflict.class !== "textual_overlap") {
    return {
      eligible: false,
      reason: `${conflict.path} is ${conflict.conflict.class}, so it stays confirmation-only`,
    };
  }
  if (
    conflict.baseContent === null ||
    conflict.candidateContent === null ||
    conflict.sourceContent === null
  ) {
    return {
      eligible: false,
      reason: `${conflict.path} is not a three-text overlap`,
    };
  }
  if (GENERATED_PATH_PATTERN.test(conflict.path) || MINIFIED_FILE_PATTERN.test(conflict.path)) {
    return {
      eligible: false,
      reason: `${conflict.path} looks generated or minified`,
    };
  }
  if (
    !ELIGIBLE_EXTENSION_PATTERN.test(conflict.path) &&
    !/^[A-Za-z0-9._/-]+$/u.test(conflict.path)
  ) {
    return {
      eligible: false,
      reason: `${conflict.path} is outside the low-risk text allowlist`,
    };
  }
  const sizes = [
    Buffer.byteLength(conflict.baseContent, "utf8"),
    Buffer.byteLength(conflict.candidateContent, "utf8"),
    Buffer.byteLength(conflict.sourceContent, "utf8"),
  ];
  if (sizes.some((size) => size > MAX_AUTO_RESOLVE_BYTES)) {
    return {
      eligible: false,
      reason: `${conflict.path} exceeds the auto-resolution size limit`,
    };
  }
  const lineCounts = [
    countLines(conflict.baseContent),
    countLines(conflict.candidateContent),
    countLines(conflict.sourceContent),
  ];
  if (lineCounts.some((count) => count > MAX_AUTO_RESOLVE_LINES)) {
    return {
      eligible: false,
      reason: `${conflict.path} exceeds the auto-resolution line limit`,
    };
  }
  return {
    eligible: true,
    reason: `${conflict.path} is a bounded text overlap eligible for apply_resolve`,
  };
};

export const buildApplyResolvePrompt = (args: {
  originalSpec: AttemptSpec;
  conflict: EligibleTextConflict;
}): { prompt: string; instructions: string[] } => {
  const { originalSpec, conflict } = args;
  const prompt = [
    `Resolve the staged apply conflict for ${conflict.path}.`,
    "",
    "Original user goal:",
    originalSpec.prompt,
    "",
    "Candidate-side instructions:",
    originalSpec.instructions.join("\n"),
    "",
    `Conflict class: ${conflict.conflict.class}`,
    `Conflict reason: ${conflict.conflict.reason}`,
    "",
    "Base content:",
    "```text",
    truncateBlock(conflict.baseContent),
    "```",
    "",
    "Candidate content:",
    "```text",
    truncateBlock(conflict.candidateContent),
    "```",
    "",
    "Current source content:",
    "```text",
    truncateBlock(conflict.sourceContent),
    "```",
  ].join("\n");

  const instructions = [
    "You are resolving one staged apply conflict inside the repository workspace.",
    "Inspect surrounding repository context if it materially improves the resolution.",
    "Do not modify repository files directly. Propose the resolved file content in result.json instead.",
    "Write JSON to $BAKUDO_GUEST_OUTPUT_DIR/result.json with exactly these keys: path, resolvedContent, rationale, confidence.",
    "Set path to the conflicted file path, resolvedContent to the full resolved file contents, rationale to a short explanation, and confidence to high, medium, or low.",
    "Use high confidence only when the resolved result is straightforward and preserves both the user goal and the current source intent.",
  ];

  return { prompt, instructions };
};

export const parseApplyResolveResult = (
  raw: string,
  expectedPath: string,
): ApplyResolutionParseResult => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    return {
      ok: false,
      error: `invalid apply_resolve result JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const validation = ApplyResolveResultSchema.safeParse(parsed);
  if (!validation.success) {
    return {
      ok: false,
      error: `invalid apply_resolve result payload: ${validation.error.issues.map((issue) => issue.message).join("; ")}`,
    };
  }

  if (validation.data.path !== expectedPath) {
    return {
      ok: false,
      error: `apply_resolve result path mismatch: expected ${expectedPath} but received ${validation.data.path}`,
    };
  }

  return {
    ok: true,
    value: validation.data,
  };
};

export const resolutionSummaryFor = (args: {
  path: string;
  confidence: ApplyResolutionConfidence;
  rationale: string;
  status: ApplyResolutionRecord["status"];
  artifacts?: string[];
  reason?: string;
  recordedAt: string;
}): ApplyResolutionRecord => ({
  path: args.path,
  confidence: args.confidence,
  rationale: args.rationale,
  status: args.status,
  recordedAt: args.recordedAt,
  ...(args.artifacts === undefined ? {} : { artifacts: args.artifacts }),
  ...(args.reason === undefined ? {} : { reason: args.reason }),
});
