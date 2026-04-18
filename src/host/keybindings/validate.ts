/**
 * User-bindings JSON validation.
 *
 * Schema (all fields optional at top level):
 *   {
 *     "Global"?:      { [keyString]: actionId },
 *     "Composer"?:    { ... },
 *     "Inspect"?:     { ... },
 *     "Dialog"?:      { ... },
 *     "Transcript"?:  { ... }
 *   }
 *
 * Validation rules:
 *  - Every key string must parse via `parseKeyBinding` (no malformed chords).
 *  - No key string may collide with a reserved trigger (see `reserved.ts`).
 *  - Within a single context, no action ID may appear twice (duplicate
 *    handler would be ambiguous).
 *  - Action IDs must be non-empty strings.
 *
 * Unknown context names are rejected (strict) — a typo in the context name
 * silently discards the user's intended bindings otherwise.
 */
import { z } from "zod";

import { encodeBinding, parseKeyBinding } from "./parser.js";
import { RESERVED_KEYS } from "./reserved.js";

export type UserBindingsFile = {
  Global?: Record<string, string>;
  Composer?: Record<string, string>;
  Inspect?: Record<string, string>;
  Dialog?: Record<string, string>;
  Transcript?: Record<string, string>;
};

export const UserBindingsSchema = z
  .object({
    Global: z.record(z.string(), z.string()).optional(),
    Composer: z.record(z.string(), z.string()).optional(),
    Inspect: z.record(z.string(), z.string()).optional(),
    Dialog: z.record(z.string(), z.string()).optional(),
    Transcript: z.record(z.string(), z.string()).optional(),
  })
  .strict();

export type ValidationResult = { ok: true } | { ok: false; errors: string[] };

const CONTEXTS: readonly (keyof UserBindingsFile)[] = [
  "Global",
  "Composer",
  "Inspect",
  "Dialog",
  "Transcript",
];

/**
 * Validate a parsed user-bindings object (the output of `JSON.parse`).
 * Performs Zod shape-check then structural/collision checks.
 */
export const validateBindings = (raw: unknown): ValidationResult => {
  const errors: string[] = [];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, errors: ["<root>: expected a plain object"] };
  }
  const zResult = UserBindingsSchema.safeParse(raw);
  if (!zResult.success) {
    for (const issue of zResult.error.issues) {
      errors.push(`${issue.path.join(".") || "<root>"}: ${issue.message}`);
    }
    return { ok: false, errors };
  }

  const data = zResult.data;
  for (const ctx of CONTEXTS) {
    const block = data[ctx];
    if (block === undefined) {
      continue;
    }
    const seenActions = new Set<string>();
    for (const [rawKey, action] of Object.entries(block)) {
      if (typeof action !== "string" || action.length === 0) {
        errors.push(`${ctx}.${rawKey}: action ID must be a non-empty string`);
        continue;
      }
      let encoded: string;
      try {
        encoded = encodeBinding(parseKeyBinding(rawKey));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`${ctx}.${rawKey}: unparseable key — ${msg}`);
        continue;
      }
      // Collision with reserved trigger. Only first stroke is checked against
      // the single-stroke reserved set; a reserved stroke as the first element
      // of a chord is also disallowed to prevent `ctrl+c <anything>` maps.
      const firstStrokeEncoded = encoded.split(" ")[0];
      if (firstStrokeEncoded !== undefined && RESERVED_KEYS.has(firstStrokeEncoded)) {
        errors.push(`${ctx}.${rawKey}: collides with reserved trigger "${firstStrokeEncoded}"`);
        continue;
      }
      if (seenActions.has(action)) {
        errors.push(`${ctx}.${rawKey}: duplicate action ID "${action}" in context`);
        continue;
      }
      seenActions.add(action);
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true };
};
