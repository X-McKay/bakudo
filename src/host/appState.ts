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

export type InspectTab = "summary" | "review" | "artifacts" | "sandbox" | "logs";

export type HostOverlay =
  | { kind: "command_palette" }
  | { kind: "session_picker" }
  | { kind: "approval"; message: string };

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
  overlay?: HostOverlay;
  notices: string[];
};

export const deriveAutoApprove = (mode: ComposerMode): boolean => mode === "autopilot";

export const initialHostAppState = (): HostAppState => ({
  screen: "transcript",
  composer: { mode: "standard", autoApprove: false, text: "" },
  inspect: { tab: "summary" },
  notices: [],
});
