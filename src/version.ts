/**
 * Version surface for bakudo. The version is read at build time from the
 * compiled module's location via a `package.json` lookup so it remains
 * accurate for both source-linked CLIs and release-bundle installs.
 *
 * Constants exposed alongside the version keep the JSON envelope stable so
 * downstream automation can key on {@link PROTOCOL_VERSION} /
 * {@link SESSION_SCHEMA_VERSION} without a second lookup.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Host protocol version. Phase 3 PR8 shipped protocol v1; this constant
 * tracks the wire-format integer surfaced on `bakudo version --output-format=json`.
 */
export const PROTOCOL_VERSION = 1 as const;

/**
 * Current session-record schema version. Phase 2 bumped this to 2 when the
 * per-session NDJSON layout stabilized; see `src/sessionTypes.ts`.
 */
export const SESSION_SCHEMA_VERSION = 2 as const;

/**
 * Walk up from `startDir` looking for a `package.json` with `"name": "bakudo"`.
 * Returns the parsed JSON on the first hit. Returns `null` if nothing is
 * found within a bounded walk (guards against runaway traversal on odd
 * installs).
 */
const findPackageJson = (startDir: string): Record<string, unknown> | null => {
  let dir = startDir;
  for (let i = 0; i < 10; i += 1) {
    try {
      const candidate = join(dir, "package.json");
      const raw = readFileSync(candidate, "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (parsed.name === "bakudo") {
        return parsed;
      }
    } catch {
      // Not here; keep walking.
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
  return null;
};

const resolveVersion = (): string => {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = findPackageJson(here);
    if (pkg && typeof pkg.version === "string") {
      return pkg.version;
    }
  } catch {
    // Fall through to the baked default.
  }
  return "0.0.0-unknown";
};

/**
 * Current bakudo version, resolved from the nearest `package.json` with
 * `name: "bakudo"`. Evaluated at module load time and cached.
 */
export const BAKUDO_VERSION: string = resolveVersion();

/**
 * JSON envelope emitted under `bakudo version --output-format=json`. Shape
 * is load-bearing for automation; do not change without bumping
 * `PROTOCOL_VERSION`.
 */
export type VersionEnvelope = {
  name: "bakudo";
  version: string;
  protocolVersion: typeof PROTOCOL_VERSION;
  sessionSchemaVersion: typeof SESSION_SCHEMA_VERSION;
};

export const buildVersionEnvelope = (): VersionEnvelope => ({
  name: "bakudo",
  version: BAKUDO_VERSION,
  protocolVersion: PROTOCOL_VERSION,
  sessionSchemaVersion: SESSION_SCHEMA_VERSION,
});
