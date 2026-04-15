export type HostScreen = "transcript" | "sessions" | "inspect" | "help";

export type ComposerMode = "build" | "plan";

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

export const initialHostAppState = (): HostAppState => ({
  screen: "transcript",
  composer: { mode: "build", autoApprove: false, text: "" },
  inspect: { tab: "summary" },
  notices: [],
});
