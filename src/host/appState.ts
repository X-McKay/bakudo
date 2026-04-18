export type HostScreen = "transcript" | "sessions" | "inspect" | "help";

/**
 * Composer modes presented to the user.
 * - "standard": Default. Build-equivalent dispatch, approval prompt before dangerous ops.
 * - "plan":     Read-only discovery / planning mode.
 * - "autopilot": Build-equivalent dispatch with auto-approval.
 *
 * Note: worker TaskMode stays "build" | "plan"; createTaskSpec translates.
 * `composer.autoApprove` is kept in state for backward compat but is
 * derived — it always equals `composer.mode === "autopilot"`.
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
  | "timeline_picker";

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
 * Derived overlay view used by renderers. Always projected from `promptQueue[0]`.
 */
export type HostOverlay =
  | { kind: "command_palette" }
  | { kind: "session_picker" }
  | { kind: "approval"; message: string }
  | { kind: "approval_prompt"; request: ApprovalPromptRequest }
  | { kind: "resume_confirm"; message: string }
  | { kind: "timeline_picker" };

export type HostAppState = {
  screen: HostScreen;
  composer: {
    mode: ComposerMode;
    autoApprove: boolean;
    text: string;
  };
  activeSessionId?: string;
  activeTurnId?: string;
  inspect: {
    sessionId?: string;
    turnId?: string;
    attemptId?: string;
    tab: InspectTab;
  };
  promptQueue: ReadonlyArray<PromptEntry>;
  notices: string[];
};

export const deriveAutoApprove = (mode: ComposerMode): boolean => mode === "autopilot";

export const initialHostAppState = (): HostAppState => ({
  screen: "transcript",
  composer: { mode: "standard", autoApprove: false, text: "" },
  inspect: { tab: "summary" },
  promptQueue: [],
  notices: [],
});
