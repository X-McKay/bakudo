import {
  deriveAutoApprove,
  type ComposerMode,
  type CommandPaletteRequest,
  type HostAppState,
  type HostScreen,
  type InspectTab,
  type PromptEntry,
  type SessionPickerPayload,
} from "./appState.js";
import { matchesFuzzy } from "./fuzzyFilter.js";

export type HostAction =
  | { type: "set_mode"; mode: ComposerMode }
  | { type: "cycle_mode" }
  | { type: "set_auto_approve"; value: boolean }
  | { type: "set_composer_text"; text: string }
  | { type: "clear_composer_text" }
  | { type: "set_active_session"; sessionId: string | undefined; turnId?: string }
  | { type: "set_screen"; screen: HostScreen }
  | {
      type: "set_inspect_target";
      sessionId?: string;
      turnId?: string;
      attemptId?: string;
      tab?: InspectTab;
    }
  | { type: "enqueue_prompt"; prompt: PromptEntry }
  | { type: "dequeue_prompt"; id: string }
  | { type: "cancel_prompt"; id?: string }
  | { type: "palette_input_change"; id: string; input: string }
  | { type: "palette_select_next"; id: string }
  | { type: "palette_select_prev"; id: string }
  | { type: "session_picker_input_change"; id: string; input: string }
  | { type: "session_picker_select_next"; id: string }
  | { type: "session_picker_select_prev"; id: string }
  | { type: "push_notice"; notice: string }
  | { type: "clear_notices" };

const withoutOptional = <T extends object, K extends keyof T>(obj: T, key: K): T => {
  if (!(key in obj)) {
    return obj;
  }
  const rest: Partial<T> = {};
  for (const field of Object.keys(obj) as Array<keyof T>) {
    if (field !== key) {
      rest[field] = obj[field];
    }
  }
  return rest as T;
};

const clearActiveSession = (state: HostAppState): HostAppState => {
  const next = withoutOptional(withoutOptional(state, "activeSessionId"), "activeTurnId");
  return next;
};

const setActiveSession = (
  state: HostAppState,
  sessionId: string,
  turnId: string | undefined,
): HostAppState => {
  const base: HostAppState = { ...state, activeSessionId: sessionId };
  if (turnId === undefined) {
    return withoutOptional(base, "activeTurnId");
  }
  return { ...base, activeTurnId: turnId };
};

const updateInspect = (
  state: HostAppState,
  patch: { sessionId?: string; turnId?: string; attemptId?: string; tab?: InspectTab },
): HostAppState => {
  const inspect: HostAppState["inspect"] = { tab: patch.tab ?? state.inspect.tab };
  const sessionId = patch.sessionId ?? state.inspect.sessionId;
  const turnId = patch.turnId ?? state.inspect.turnId;
  const attemptId = patch.attemptId ?? state.inspect.attemptId;
  if (sessionId !== undefined) {
    inspect.sessionId = sessionId;
  }
  if (turnId !== undefined) {
    inspect.turnId = turnId;
  }
  if (attemptId !== undefined) {
    inspect.attemptId = attemptId;
  }
  return { ...state, inspect };
};

/**
 * Walk the prompt queue and rewrite the payload of the `command_palette`
 * entry with id `promptId`. Returns the original state when no matching
 * entry exists (defensive — reducers must stay total).
 */
const updatePalettePayload = (
  state: HostAppState,
  promptId: string,
  mutate: (payload: CommandPaletteRequest) => CommandPaletteRequest,
): HostAppState => {
  let changed = false;
  const nextQueue = state.promptQueue.map((entry) => {
    if (entry.id !== promptId || entry.kind !== "command_palette") {
      return entry;
    }
    const payload = entry.payload as CommandPaletteRequest;
    const updated = mutate(payload);
    if (updated === payload) {
      return entry;
    }
    changed = true;
    return { ...entry, payload: updated };
  });
  if (!changed) {
    return state;
  }
  return { ...state, promptQueue: nextQueue };
};

const updateSessionPickerPayload = (
  state: HostAppState,
  promptId: string,
  mutate: (payload: SessionPickerPayload) => SessionPickerPayload,
): HostAppState => {
  let changed = false;
  const nextQueue = state.promptQueue.map((entry) => {
    if (entry.id !== promptId || entry.kind !== "session_picker") {
      return entry;
    }
    const payload = entry.payload as SessionPickerPayload;
    const updated = mutate(payload);
    if (updated === payload) {
      return entry;
    }
    changed = true;
    return { ...entry, payload: updated };
  });
  if (!changed) {
    return state;
  }
  return { ...state, promptQueue: nextQueue };
};

const countPaletteVisible = (payload: CommandPaletteRequest): number => {
  if (payload.input.length === 0) {
    return payload.items.length;
  }
  let count = 0;
  for (const item of payload.items) {
    if (matchesFuzzy(item.name, payload.input)) {
      count += 1;
    }
  }
  return count;
};

const countSessionPickerVisible = (payload: SessionPickerPayload): number => {
  if (payload.input.length === 0) {
    return payload.items.length;
  }
  let count = 0;
  for (const item of payload.items) {
    if (matchesFuzzy(item.label, payload.input)) {
      count += 1;
    }
  }
  return count;
};

const COMPOSER_MODE_CYCLE: readonly ComposerMode[] = ["standard", "plan", "autopilot"];

const nextComposerMode = (current: ComposerMode): ComposerMode => {
  const index = COMPOSER_MODE_CYCLE.indexOf(current);
  const nextIndex = index === -1 ? 0 : (index + 1) % COMPOSER_MODE_CYCLE.length;
  return COMPOSER_MODE_CYCLE[nextIndex]!;
};

const setMode = (state: HostAppState, mode: ComposerMode): HostAppState => {
  const autoApprove = deriveAutoApprove(mode);
  if (state.composer.mode === mode && state.composer.autoApprove === autoApprove) {
    return state;
  }
  return { ...state, composer: { ...state.composer, mode, autoApprove } };
};

export const reduceHost = (state: HostAppState, action: HostAction): HostAppState => {
  switch (action.type) {
    case "set_mode":
      return setMode(state, action.mode);
    case "cycle_mode":
      return setMode(state, nextComposerMode(state.composer.mode));
    case "set_auto_approve": {
      const notice = `set_auto_approve ignored; derive from mode === "autopilot" (was ${state.composer.autoApprove}, requested ${action.value})`;
      return state.composer.autoApprove === action.value
        ? state
        : { ...state, notices: [...state.notices, notice] };
    }
    case "set_composer_text":
      if (state.composer.text === action.text) {
        return state;
      }
      return { ...state, composer: { ...state.composer, text: action.text } };
    case "clear_composer_text":
      if (state.composer.text === "") {
        return state;
      }
      return { ...state, composer: { ...state.composer, text: "" } };
    case "set_active_session":
      if (action.sessionId === undefined) {
        return clearActiveSession(state);
      }
      return setActiveSession(state, action.sessionId, action.turnId);
    case "set_screen":
      if (state.screen === action.screen) {
        return state;
      }
      return { ...state, screen: action.screen };
    case "set_inspect_target":
      return updateInspect(state, action);
    case "enqueue_prompt":
      return { ...state, promptQueue: [...state.promptQueue, action.prompt] };
    case "dequeue_prompt": {
      const filtered = state.promptQueue.filter((entry) => entry.id !== action.id);
      if (filtered.length === state.promptQueue.length) {
        return state;
      }
      return { ...state, promptQueue: filtered };
    }
    case "cancel_prompt": {
      if (state.promptQueue.length === 0) {
        return state;
      }
      if (action.id === undefined) {
        // Cancel the head entry.
        return { ...state, promptQueue: state.promptQueue.slice(1) };
      }
      const filtered = state.promptQueue.filter((entry) => entry.id !== action.id);
      if (filtered.length === state.promptQueue.length) {
        return state;
      }
      return { ...state, promptQueue: filtered };
    }
    case "palette_input_change":
      return updatePalettePayload(state, action.id, (payload) => ({
        ...payload,
        input: action.input,
        // Reset selection to the first row of the new filtered view so the
        // cursor stays valid. `max(0, ...)` avoids -1 when nothing matches.
        selectedIndex: 0,
      }));
    case "palette_select_next":
      return updatePalettePayload(state, action.id, (payload) => {
        const filteredCount = countPaletteVisible(payload);
        if (filteredCount === 0) {
          return payload;
        }
        return {
          ...payload,
          selectedIndex: (payload.selectedIndex + 1) % filteredCount,
        };
      });
    case "palette_select_prev":
      return updatePalettePayload(state, action.id, (payload) => {
        const filteredCount = countPaletteVisible(payload);
        if (filteredCount === 0) {
          return payload;
        }
        const next = payload.selectedIndex - 1;
        return {
          ...payload,
          selectedIndex: next < 0 ? filteredCount - 1 : next,
        };
      });
    case "session_picker_input_change":
      return updateSessionPickerPayload(state, action.id, (payload) => ({
        ...payload,
        input: action.input,
        selectedIndex: 0,
      }));
    case "session_picker_select_next":
      return updateSessionPickerPayload(state, action.id, (payload) => {
        const filteredCount = countSessionPickerVisible(payload);
        if (filteredCount === 0) {
          return payload;
        }
        return {
          ...payload,
          selectedIndex: (payload.selectedIndex + 1) % filteredCount,
        };
      });
    case "session_picker_select_prev":
      return updateSessionPickerPayload(state, action.id, (payload) => {
        const filteredCount = countSessionPickerVisible(payload);
        if (filteredCount === 0) {
          return payload;
        }
        const next = payload.selectedIndex - 1;
        return {
          ...payload,
          selectedIndex: next < 0 ? filteredCount - 1 : next,
        };
      });
    case "push_notice":
      return { ...state, notices: [...state.notices, action.notice] };
    case "clear_notices":
      if (state.notices.length === 0) {
        return state;
      }
      return { ...state, notices: [] };
  }
};
