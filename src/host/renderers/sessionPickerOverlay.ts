/**
 * Phase 5 PR7 — Session-picker overlay renderer.
 *
 * Mirrors {@link renderCommandPaletteOverlayLines} — shares the header /
 * banner / cursor convention. Separated so the two pickers can evolve
 * independently without entangling.
 */
import type { SessionPickerPayload } from "../appState.js";
import { matchesFuzzy } from "../fuzzyFilter.js";

export const filterSessionPickerItems = (
  payload: SessionPickerPayload,
): ReadonlyArray<SessionPickerPayload["items"][number]> => {
  if (payload.input.length === 0) {
    return payload.items;
  }
  return payload.items.filter((item) => matchesFuzzy(item.label, payload.input));
};

export const renderSessionPickerOverlayLines = (payload: SessionPickerPayload): string[] => {
  const visible = filterSessionPickerItems(payload);
  const header = `> ${payload.input}`;
  const banner = "[session picker]";
  if (visible.length === 0) {
    return [header, banner, "(no matches)"];
  }
  const selected = Math.min(payload.selectedIndex, visible.length - 1);
  const rows = visible.map((item, index) => {
    const cursor = index === selected ? "❯" : " ";
    return `${cursor} ${item.label}`;
  });
  return [header, banner, ...rows];
};
