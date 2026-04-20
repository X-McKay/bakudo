import type { TranscriptItem } from "./renderModel.js";

export type HostScreen = "transcript" | "sessions" | "inspect" | "help";

export type DispatchState =
  | { inFlight: false }
  | { inFlight: true; startedAt: number; label: string; detail?: string };

export type PendingSubmit = { seq: number; text: string };
export type ShouldExit = { code: number };

/**
 * Composer modes presented to the user.
 * - "standard": Default. Build-equivalent dispatch, approval prompt before dangerous ops.
 * - "plan":     Read-only discovery / planning mode.
 * - "autopilot": Build-equivalent dispatch with auto-approval.
 *
 * Note: worker TaskMode stays "build" | "plan"; the planner maps this to
 * an `ExecutionProfile` inside a `DispatchPlan`. `composer.autoApprove` is
 * kept in state for backward compat but is derived — it always equals
 * `composer.mode === "autopilot"`.
 */
export type ComposerMode = "standard" | "plan" | "autopilot";

/**
 * Phase 4 PR4 adds a `provenance` tab for the per-attempt dispatch record
 * and a `approvals` tab for the per-turn approval audit trail. The pre-PR4
 * `sandbox` tab is retained so any external callers that still request it
 * keep working — the dispatcher aliases it to the new `provenance` renderer.
 */
export type InspectTab =
  | "summary"
  | "review"
  | "provenance"
  | "artifacts"
  | "approvals"
  | "sandbox"
  | "logs";

export type PromptKind =
  | "approval"
  | "approval_prompt"
  | "resume_confirm"
  | "command_palette"
  | "session_picker"
  | "timeline_picker"
  | "quick_help";

/**
 * Payload for the `quick_help` overlay — the `?` modal that projects the
 * active keybinding set for the current context. `dialogKind` is populated
 * when the overlay opens while another dialog is pending so the help lines
 * can tailor to that dialog's verbs (confirm/cancel/back vs. navigate).
 */
export type QuickHelpContext = "composer" | "inspect" | "dialog" | "transcript";

export type QuickHelpPayload = {
  context: QuickHelpContext;
  dialogKind?: string;
};

export type PromptEntry = {
  id: string;
  kind: PromptKind;
  payload: unknown;
};

/**
 * Payload shape carried on an `approval_prompt` queue entry. Keep narrow —
 * renderers project from these fields verbatim (see `dialogLauncher.ts` and
 * the Phase 4 approval-prompt copy in renderers).
 */
export type ApprovalPromptRequest = {
  sessionId: string;
  turnId: string;
  attemptId?: string;
  tool: string;
  argument: string;
  policySnapshot: {
    agent: string;
    composerMode: ComposerMode;
    autopilot: boolean;
  };
};

/**
 * Count of options the approval prompt cursor cycles through: [1] allow
 * once, [2] allow always, [3] deny, [4] show context. Exported so reducers
 * and renderers stay in sync with the option list in `approvalPromptCopy`.
 */
export const APPROVAL_DIALOG_CURSOR_COUNT = 4;

/**
 * Payload carried on a `command_palette` prompt entry. `items` is the full
 * command list (name + description), populated by the launcher. `input`
 * holds the current filter text, and `selectedIndex` is the highlighted row
 * *within the filtered view*. Renderers project these fields verbatim.
 *
 * The reducer owns the evolution of `input` / `selectedIndex`; the launcher
 * only inspects the final state when the user confirms.
 */
export type CommandPaletteItem = {
  name: string;
  description: string;
};

export type CommandPaletteRequest = {
  items: ReadonlyArray<CommandPaletteItem>;
  input: string;
  selectedIndex: number;
};

/**
 * Payload carried on a `session_picker` prompt entry. Same shape as the
 * command palette — the fuzzy-filter machinery is identical; only the item
 * vocabulary differs. `items` is pre-sorted newest-first before the launcher
 * enqueues.
 */
export type SessionPickerItem = {
  sessionId: string;
  label: string;
};

export type SessionPickerPayload = {
  items: ReadonlyArray<SessionPickerItem>;
  input: string;
  selectedIndex: number;
};

/**
 * Derived overlay view used by renderers. Always projected from `promptQueue[0]`.
 */
export type HostOverlay =
  | { kind: "command_palette"; request: CommandPaletteRequest }
  | { kind: "session_picker"; request: SessionPickerPayload }
  | { kind: "approval"; message: string }
  | { kind: "approval_prompt"; request: ApprovalPromptRequest; cursorIndex: number }
  | { kind: "resume_confirm"; message: string }
  | { kind: "timeline_picker" }
  | { kind: "quick_help"; context: QuickHelpContext; dialogKind?: string };

/**
 * Windowed-scroll state for the Inspect pane. `scrollOffset` is the index
 * of the first visible line within the active tab's formatted output;
 * `scrollHeight` is the viewport height reported by the renderer (number
 * of lines that fit at once). The reducer clamps `scrollOffset` against
 * the formatted content length at the call site — total content length is
 * unknown to the reducer, so the renderer's windowing helper handles the
 * final clamp. See `inspectScroll.ts`.
 */
export type InspectState = {
  sessionId?: string;
  turnId?: string;
  attemptId?: string;
  tab: InspectTab;
  scrollOffset: number;
  scrollHeight: number;
};

export type HostAppState = {
  screen: HostScreen;
  composer: {
    mode: ComposerMode;
    autoApprove: boolean;
    text: string;
    model: string;
    agent: string;
    provider: string;
  };
  activeSessionId?: string;
  activeTurnId?: string;
  inspect: InspectState;
  promptQueue: ReadonlyArray<PromptEntry>;
  notices: string[];
  transcript: ReadonlyArray<TranscriptItem>;
  dispatch: DispatchState;
  pendingSubmit?: PendingSubmit;
  shouldExit?: ShouldExit;
  /**
   * Cursor index for the approval prompt's [1]/[2]/[3]/[4] option list.
   * Shift+Tab cycles through the options (see `reducer` actions
   * `approval_dialog_cursor_*`). Always in `[0, APPROVAL_DIALOG_CURSOR_COUNT)`.
   */
  approvalDialogCursor: number;
  /**
   * When set, the `?` quick-help overlay is active and preempts any pending
   * dialog. `dialogKind` carries the underlying dialog kind so the help
   * content can show the right verbs. See `renderModel.promoteQuickHelp`.
   */
  quickHelp?: QuickHelpPayload;
};

export const deriveAutoApprove = (mode: ComposerMode): boolean => mode === "autopilot";

/** Default viewport height when the renderer has not reported one yet. */
export const DEFAULT_INSPECT_SCROLL_HEIGHT = 20;

export const initialHostAppState = (): HostAppState => ({
  screen: "transcript",
  composer: {
    mode: "standard",
    autoApprove: false,
    text: "",
    model: "",
    agent: "",
    provider: "",
  },
  inspect: {
    tab: "summary",
    scrollOffset: 0,
    scrollHeight: DEFAULT_INSPECT_SCROLL_HEIGHT,
  },
  promptQueue: [],
  notices: [],
  transcript: [],
  dispatch: { inFlight: false },
  approvalDialogCursor: 0,
});
