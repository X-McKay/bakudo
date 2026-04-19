/**
 * Loader for `bakudo help <topic>` content. Topics live as markdown files
 * under `<repo>/docs/help/<topic>.md` and are bundled with the CLI at
 * build time (the files are also included in the release bundle; see README
 * for install steps).
 *
 * The loader resolves topic paths relative to the compiled module
 * location so it works under both `pnpm dev` (src → dist) and installed
 * CLI wrappers.
 */

import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Known help topics. Keep this in sync with the markdown files under
 * `docs/help/`. Additions require both a new file AND an entry here.
 */
export const KNOWN_HELP_TOPICS: readonly string[] = [
  "config",
  "hooks",
  "permissions",
  "monitoring",
  "sandbox",
] as const;

export type HelpTopic = (typeof KNOWN_HELP_TOPICS)[number];

export const isKnownHelpTopic = (name: string): name is HelpTopic =>
  (KNOWN_HELP_TOPICS as readonly string[]).includes(name);

/**
 * Candidate directories to look for `docs/help/`. Ordered most-likely
 * first:
 *  1. Walking up from the compiled module (works under `dist/`).
 *  2. `process.cwd()/docs/help/` (dev invocation from the repo root).
 */
const candidateHelpDirs = (): string[] => {
  const dirs = new Set<string>();
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    let walker = here;
    for (let i = 0; i < 6; i += 1) {
      dirs.add(join(walker, "docs", "help"));
      const parent = dirname(walker);
      if (parent === walker) {
        break;
      }
      walker = parent;
    }
  } catch {
    // Ignore — fall back to cwd.
  }
  try {
    const proc = (globalThis as unknown as { process?: { cwd?: () => string } }).process;
    const cwd = proc?.cwd?.() ?? ".";
    dirs.add(resolve(cwd, "docs", "help"));
  } catch {
    // Ignore.
  }
  return Array.from(dirs);
};

export const helpTopicFileName = (topic: string): string => `${topic}.md`;

/**
 * Locate an existing markdown file for `topic`. Returns the first
 * candidate that reads successfully. Callers convert the resolved path
 * into a topic body via the returned `{ path, content }` pair.
 */
export const loadHelpTopic = async (
  topic: string,
): Promise<{ path: string; content: string } | null> => {
  if (!isKnownHelpTopic(topic)) {
    return null;
  }
  const file = helpTopicFileName(topic);
  for (const dir of candidateHelpDirs()) {
    const candidate = join(dir, file);
    try {
      const content = await readFile(candidate, "utf8");
      return { path: candidate, content };
    } catch {
      // Try the next candidate.
    }
  }
  return null;
};

/**
 * List available topics by combining the known list with whatever is
 * actually present on disk. Useful for `bakudo help` (no topic) which
 * prints both the canonical list and any experimental topics found.
 */
export const listAvailableHelpTopics = async (): Promise<string[]> => {
  const known = new Set<string>(KNOWN_HELP_TOPICS);
  for (const dir of candidateHelpDirs()) {
    try {
      const entries = await readdir(dir);
      for (const entry of entries) {
        if (entry.endsWith(".md")) {
          known.add(entry.slice(0, -".md".length));
        }
      }
      break;
    } catch {
      // Try the next candidate.
    }
  }
  return Array.from(known).sort();
};

/**
 * Build a helpful error message when a requested topic is unknown.
 */
export const unknownTopicMessage = (topic: string): string =>
  `Unknown help topic: "${topic}". Try one of: ${KNOWN_HELP_TOPICS.join(", ")}.`;
