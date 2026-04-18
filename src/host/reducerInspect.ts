/**
 * Phase 5 PR8 — Reducer helpers for Inspect scroll + tab cycling +
 * approval-dialog cursor. Split out of `reducer.ts` so the file stays
 * under the 400-line project cap.
 *
 * All helpers are pure — input state in, next state out. Nothing reads
 * from disk or mutates globals. See `reducer.ts` for the action-type
 * union that wires these into the dispatcher.
 */
import { APPROVAL_DIALOG_CURSOR_COUNT, type HostAppState, type InspectTab } from "./appState.js";

/** Ordered InspectTab cycle used by `inspect_tab_next` / `inspect_tab_prev`. */
export const INSPECT_TAB_CYCLE: readonly InspectTab[] = [
  "summary",
  "review",
  "provenance",
  "artifacts",
  "approvals",
  "logs",
];

export const SCROLL_LINE_STEP = 1;
/** A page scroll advances by (height - 1) so a row of overlap survives. */
export const scrollPageStep = (height: number): number => Math.max(1, height - 1);

export const withInspect = (
  state: HostAppState,
  inspect: HostAppState["inspect"],
): HostAppState => {
  if (
    inspect.scrollOffset === state.inspect.scrollOffset &&
    inspect.scrollHeight === state.inspect.scrollHeight &&
    inspect.tab === state.inspect.tab
  ) {
    return state;
  }
  return { ...state, inspect };
};

export const scrollBy = (state: HostAppState, delta: number): HostAppState => {
  const next = Math.max(0, state.inspect.scrollOffset + delta);
  if (next === state.inspect.scrollOffset) {
    return state;
  }
  return withInspect(state, { ...state.inspect, scrollOffset: next });
};

const nextTabIndex = (current: InspectTab, dir: 1 | -1): InspectTab => {
  const idx = INSPECT_TAB_CYCLE.indexOf(current);
  const base = idx === -1 ? 0 : idx;
  const len = INSPECT_TAB_CYCLE.length;
  const nextIdx = (base + dir + len) % len;
  return INSPECT_TAB_CYCLE[nextIdx]!;
};

export const cycleTab = (state: HostAppState, dir: 1 | -1): HostAppState => {
  const tab = nextTabIndex(state.inspect.tab, dir);
  if (tab === state.inspect.tab) {
    return state;
  }
  // Tab cycling also resets scroll to the top so the user sees the new tab's
  // header row, matching the reset semantics of `set_inspect_target`.
  return withInspect(state, { ...state.inspect, tab, scrollOffset: 0 });
};

export const cycleApprovalCursor = (state: HostAppState, dir: 1 | -1): HostAppState => {
  const count = APPROVAL_DIALOG_CURSOR_COUNT;
  const next = (state.approvalDialogCursor + dir + count) % count;
  if (next === state.approvalDialogCursor) {
    return state;
  }
  return { ...state, approvalDialogCursor: next };
};
