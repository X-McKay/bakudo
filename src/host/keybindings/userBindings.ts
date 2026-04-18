/**
 * Load and merge `~/.config/bakudo/keybindings.json` against the shipped
 * defaults. Uses the same XDG path resolution as `src/host/config.ts` so the
 * two config files coexist under `~/.config/bakudo/`.
 *
 * Merge semantics:
 *  - Start with `buildDefaultBindings()` as the base.
 *  - For each user context block: user entries override the *action* for a
 *    given trigger. Reserved triggers are silently dropped (validate.ts is
 *    the authoritative point for user-visible errors; this loader is
 *    tolerant so a downstream dispatch path never crashes).
 *  - Unknown / malformed blocks are dropped with a one-line stderr warning
 *    (matching `config.ts`'s tolerant-merge pattern).
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { stderrWrite } from "../io.js";

import { buildDefaultBindings, type KeybindingBlock, type KeybindingContext } from "./defaults.js";
import { encodeBinding, parseKeyBinding } from "./parser.js";
import { RESERVED_KEYS } from "./reserved.js";
import { validateBindings, type UserBindingsFile } from "./validate.js";

/**
 * Resolve the XDG config path for `<app>/<file>`. Kept local to avoid a
 * circular import with `config.ts`; logic mirrors `xdgConfigPath` there.
 */
export const xdgKeybindingsPath = (): string => {
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(base, "bakudo", "keybindings.json");
};

const readJsonFile = async (filePath: string): Promise<unknown | null> => {
  try {
    const content = await readFile(filePath, "utf8");
    return JSON.parse(content) as unknown;
  } catch {
    return null;
  }
};

const CONTEXT_NAMES: readonly KeybindingContext[] = [
  "Global",
  "Composer",
  "Inspect",
  "Dialog",
  "Transcript",
];

/**
 * Rebuild a base block's binding map under canonical-encoded keys, so user
 * overrides compare equal to defaults even when the user's spelling differs
 * (e.g. `"Ctrl+K"` vs `"ctrl+k"`). Unparseable default keys are preserved
 * as-is (defaults are author-controlled; an unparseable default is a bug
 * that should not silently disappear).
 */
const canonicalizeBase = (baseBlock: KeybindingBlock): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [rawKey, action] of Object.entries(baseBlock.bindings)) {
    try {
      out[encodeBinding(parseKeyBinding(rawKey))] = action;
    } catch {
      out[rawKey] = action;
    }
  }
  return out;
};

/**
 * Apply a validated user block onto a defaults block. Reserved triggers are
 * filtered out defensively even though `validateBindings` should have
 * flagged them. Unparseable keys are also dropped silently here (the
 * validator is the user-visible error surface).
 */
const mergeContextBlock = (
  baseBlock: KeybindingBlock,
  userBlock: Record<string, string> | undefined,
): KeybindingBlock => {
  if (userBlock === undefined) {
    return baseBlock;
  }
  const merged: Record<string, string> = canonicalizeBase(baseBlock);
  for (const [rawKey, action] of Object.entries(userBlock)) {
    if (typeof action !== "string" || action.length === 0) {
      continue;
    }
    let encoded: string;
    try {
      encoded = encodeBinding(parseKeyBinding(rawKey));
    } catch {
      continue;
    }
    const firstStroke = encoded.split(" ")[0];
    if (firstStroke !== undefined && RESERVED_KEYS.has(firstStroke)) {
      continue;
    }
    merged[encoded] = action;
  }
  return { context: baseBlock.context, bindings: merged };
};

export type MergedBindings = {
  blocks: KeybindingBlock[];
  source: "defaults" | "user+defaults";
  userPath: string;
};

/**
 * Load + merge. Never throws — returns defaults on any error.
 */
export const loadUserBindings = async (
  path: string = xdgKeybindingsPath(),
): Promise<MergedBindings> => {
  const raw = await readJsonFile(path);
  if (raw === null) {
    return { blocks: buildDefaultBindings(), source: "defaults", userPath: path };
  }
  const validation = validateBindings(raw);
  if (!validation.ok) {
    stderrWrite(`[bakudo.keybindings] ignoring ${path}: ${validation.errors.join("; ")}\n`);
    return { blocks: buildDefaultBindings(), source: "defaults", userPath: path };
  }
  const user = raw as UserBindingsFile;
  const defaults = buildDefaultBindings();
  const blocks: KeybindingBlock[] = defaults.map((block) => {
    const contextName = block.context;
    if (!CONTEXT_NAMES.includes(contextName)) {
      return block;
    }
    return mergeContextBlock(block, user[contextName]);
  });
  return { blocks, source: "user+defaults", userPath: path };
};
