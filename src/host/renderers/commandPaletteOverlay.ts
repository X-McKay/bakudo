/**
 * Phase 5 PR7 — Command-palette overlay renderer.
 *
 * Output shape is a simple vertical stack:
 *
 *   > <input>                          ← live query line
 *   [command palette]                  ← heading (disambiguates from
 *                                        session-picker; useful for logs)
 *   ❯ /name  — description             ← cursor-marked selected row
 *     /name  — description             ← remaining filtered rows
 *     …
 *   (no matches)                       ← if the filter returns zero rows
 *
 * Lines are returned as a plain `string[]` (like the approval-prompt copy
 * renderer). Callers (`transcriptRenderer`, `plainRenderer`) decide how to
 * colorize or pass through.
 *
 * The renderer is pure: it inspects the payload only. It does not touch
 * the `promptResolvers` or the reducer.
 */
import type { CommandPaletteRequest } from "../appState.js";
import { matchesFuzzy } from "../fuzzyFilter.js";

/**
 * Filter the item list with the current query. Extracted so both the
 * renderer and the reducer can share the same predicate.
 */
export const filterPaletteItems = (
  request: CommandPaletteRequest,
): ReadonlyArray<CommandPaletteRequest["items"][number]> => {
  if (request.input.length === 0) {
    return request.items;
  }
  return request.items.filter((item) => matchesFuzzy(item.name, request.input));
};

/**
 * Build the overlay lines. Kept plain (no ANSI) so both the transcript
 * renderer (which wraps with theme colors) and the plain renderer (which
 * emits as-is) can reuse the same projection.
 */
export const renderCommandPaletteOverlayLines = (request: CommandPaletteRequest): string[] => {
  const visible = filterPaletteItems(request);
  const header = `> ${request.input}`;
  const banner = "[command palette]";
  if (visible.length === 0) {
    return [header, banner, "(no matches)"];
  }
  const selected = Math.min(request.selectedIndex, visible.length - 1);
  const rows = visible.map((item, index) => {
    const cursor = index === selected ? "❯" : " ";
    return `${cursor} /${item.name}  — ${item.description}`;
  });
  return [header, banner, ...rows];
};
