import type {
  ComposerMode,
  HostAppState,
  HostOverlay,
  HostScreen,
  InspectTab,
} from "./appState.js";

export type HostAction =
  | { type: "set_mode"; mode: ComposerMode }
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
  | { type: "open_overlay"; overlay: HostOverlay }
  | { type: "close_overlay" }
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

export const reduceHost = (state: HostAppState, action: HostAction): HostAppState => {
  switch (action.type) {
    case "set_mode":
      if (state.composer.mode === action.mode) {
        return state;
      }
      return { ...state, composer: { ...state.composer, mode: action.mode } };
    case "set_auto_approve":
      if (state.composer.autoApprove === action.value) {
        return state;
      }
      return { ...state, composer: { ...state.composer, autoApprove: action.value } };
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
    case "open_overlay":
      return { ...state, overlay: action.overlay };
    case "close_overlay":
      if (state.overlay === undefined) {
        return state;
      }
      return withoutOptional(state, "overlay");
    case "push_notice":
      return { ...state, notices: [...state.notices, action.notice] };
    case "clear_notices":
      if (state.notices.length === 0) {
        return state;
      }
      return { ...state, notices: [] };
  }
};
