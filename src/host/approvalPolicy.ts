import type { PermissionTool } from "../attemptProtocol.js";

/**
 * Render a permission request as a single display string for the approval
 * prompt. Mirrors the verbatim copy in the Phase 4 spec:
 *
 *     Bakudo: Worker wants to run: shell(git push origin main)
 *
 * where `"shell(git push origin main)"` is the display command.
 */
export const renderPermissionDisplayCommand = (tool: string, argument: string): string =>
  `${tool}(${argument})`;

/**
 * Propose the glob pattern the user would persist if they picked
 * "allow always for <pattern>" in the approval prompt. The heuristic is
 * deliberately simple and predictable — the user always sees the suggested
 * pattern before it persists, so a mildly over-general or under-general
 * suggestion is an opportunity to edit, not a correctness hazard.
 *
 * Rules:
 *
 * 1. **`shell`:** the argument is typically a shell invocation starting
 *    with a program name. Use the first whitespace-delimited token plus a
 *    `:*` wildcard (mirrors the Copilot `shell(git:*)` grammar and the
 *    design note example `git push:*`).
 *    - `"git push origin main"` → `"git push:*"`
 *    - `"git commit -m 'x'"` → `"git commit:*"`
 *    - `"ls -la"` → `"ls:*"`
 *    - Empty/whitespace argument → `"*"` (fall back to allow-any).
 *
 * 2. **`write` / `edit`:** the argument is a path. Generalise the filename
 *    to any sibling under the same directory.
 *    - `"src/foo/bar.ts"` → `"src/foo/*"`
 *    - `"package.json"` → `"*"` (no directory to preserve).
 *
 * 3. **`network`:** the argument is a URL or host. Preserve the host,
 *    wildcard the path.
 *    - `"https://api.github.com/repos/x/y"` → `"https://api.github.com/**"`
 *    - `"api.example.com"` → `"api.example.com/**"` (scheme-less hosts
 *      accepted).
 *
 * 4. **Everything else** (including unknown tools): fall back to `"*"`.
 */
export const suggestAllowAlwaysPattern = (tool: PermissionTool, argument: string): string => {
  const trimmed = argument.trim();
  if (trimmed.length === 0) {
    return "*";
  }

  if (tool === "shell") {
    // First two tokens for git-style subcommands; otherwise just the
    // program name.
    const tokens = trimmed.split(/\s+/u);
    const first = tokens[0];
    if (first === undefined || first.length === 0) {
      return "*";
    }
    if (first === "git" && tokens[1] !== undefined && tokens[1].length > 0) {
      return `git ${tokens[1]}:*`;
    }
    return `${first}:*`;
  }

  if (tool === "write" || tool === "edit") {
    const slash = trimmed.lastIndexOf("/");
    if (slash <= 0) {
      return "*";
    }
    return `${trimmed.slice(0, slash)}/*`;
  }

  if (tool === "network") {
    // Strip scheme + preserve host.
    const schemeMatch = /^([a-z][a-z0-9+.-]*):\/\/([^/]+)(\/.*)?$/iu.exec(trimmed);
    if (schemeMatch !== null) {
      const scheme = schemeMatch[1];
      const host = schemeMatch[2];
      return `${scheme}://${host}/**`;
    }
    // Bare host — no scheme.
    const hostEnd = trimmed.indexOf("/");
    const host = hostEnd === -1 ? trimmed : trimmed.slice(0, hostEnd);
    return `${host}/**`;
  }

  return "*";
};
