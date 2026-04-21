import type {
  ApprovalPromptRequest,
  CommandPaletteRequest,
  ComposerMode,
  HostAppState,
  HostOverlay,
  PromptEntry,
  RecoveryDialogPayload,
  SessionPickerPayload,
} from "./appState.js";

export type FrameMode = "prompt" | "transcript";

export type TranscriptItem =
  | { kind: "user"; text: string; timestamp?: string }
  | { kind: "assistant"; text: string; tone?: "info" | "success" | "warning" | "error" }
  | { kind: "event"; label: string; detail?: string }
  | { kind: "output"; text: string }
  | { kind: "review"; outcome: string; summary: string; nextAction?: string };

export type RenderFrame = {
  mode: FrameMode;
  header: {
    title: string;
    mode: ComposerMode;
    sessionLabel: string;
    repoLabel?: string;
  };
  transcript: TranscriptItem[];
  footer: {
    hints: string[];
  };
  composer: {
    placeholder: string;
    mode: ComposerMode;
    autoApprove: boolean;
  };
  overlay?: HostOverlay;
  inspectPane?: {
    title: string;
    lines: string[];
  };
};

export type FrameInputs = {
  state: HostAppState;
  transcript: TranscriptItem[];
  repoLabel?: string;
};

const truncateMiddle = (value: string, head: number, tail: number): string => {
  if (value.length <= head + tail + 1) {
    return value;
  }
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
};

const displaySessionId = (sessionId: string): string => {
  const trimmed = sessionId.startsWith("session-") ? sessionId.slice("session-".length) : sessionId;
  return truncateMiddle(trimmed, 10, 3);
};

const displayTurnId = (turnId: string | undefined): string | undefined => {
  if (turnId === undefined || turnId.length === 0) {
    return undefined;
  }
  const match = /^turn-(.+)$/u.exec(turnId);
  return match ? `turn ${match[1]}` : turnId;
};

const sessionLabelFor = (
  activeSessionId: string | undefined,
  activeTurnId: string | undefined,
): string => {
  if (!activeSessionId) {
    return "new session";
  }
  const session = `session ${displaySessionId(activeSessionId)}`;
  const turn = displayTurnId(activeTurnId);
  return turn === undefined ? session : `${session} / ${turn}`;
};

const footerHintsFor = (state: HostAppState, overlay: HostOverlay | undefined): string[] => {
  if (overlay?.kind === "approval_prompt") {
    return ["[1/2/3/4] choose", "[Shift+Tab] cycle", "[?] help", "[Ctrl+C] exit"];
  }
  if (overlay?.kind === "recovery_dialog") {
    return ["[r] retry", "[h] halt", "[e] edit", "[?] help", "[Ctrl+C] exit"];
  }
  if (overlay?.kind === "command_palette" || overlay?.kind === "session_picker") {
    return ["[↑/↓] move", "[Enter] select", "[?] help", "[Ctrl+C] exit"];
  }
  if (overlay?.kind === "quick_help") {
    return ["[?] close", "[Ctrl+C] exit"];
  }
  if (state.screen === "inspect") {
    return ["[Shift+Tab] tabs", "[↑/↓] scroll", "[?] help", "[Ctrl+C] exit"];
  }
  if (overlay !== undefined) {
    return ["[/] commands", "[?] help", "[Ctrl+C] exit"];
  }
  if (state.activeSessionId) {
    return ["[inspect]", "[inspect provenance]", "[new]", "[resume]"];
  }
  return ["[new]", "[resume]", "[help]"];
};

const deriveOverlay = (
  prompt: PromptEntry | undefined,
  state: HostAppState,
): HostOverlay | undefined => {
  if (prompt === undefined) {
    return undefined;
  }
  if (prompt.kind === "approval") {
    const payload = prompt.payload as { message?: unknown } | null;
    const message = typeof payload?.message === "string" ? payload.message : "";
    return { kind: "approval", message };
  }
  if (prompt.kind === "approval_prompt") {
    // No defensive fallback: enqueueing an `approval_prompt` without a
    // well-formed payload is a programming error (see `dialogLauncher.ts`
    // where the only producer lives).
    const request = prompt.payload as ApprovalPromptRequest;
    return {
      kind: "approval_prompt",
      request,
      cursorIndex: state.approvalDialogCursor,
    };
  }
  if (prompt.kind === "recovery_dialog") {
    const payload = prompt.payload as RecoveryDialogPayload;
    return { kind: "recovery_dialog", payload };
  }
  if (prompt.kind === "resume_confirm") {
    const payload = prompt.payload as { message?: unknown } | null;
    const message = typeof payload?.message === "string" ? payload.message : "";
    return { kind: "resume_confirm", message };
  }
  if (prompt.kind === "command_palette") {
    // Payload well-formedness is a producer contract — only the
    // `launchCommandPaletteDialog` launcher creates these entries.
    const request = prompt.payload as CommandPaletteRequest;
    return { kind: "command_palette", request };
  }
  if (prompt.kind === "timeline_picker") {
    return { kind: "timeline_picker" };
  }
  const request = prompt.payload as SessionPickerPayload;
  return { kind: "session_picker", request };
};

/**
 * If `state.quickHelp` is set, the `?` overlay preempts whatever dialog is
 * currently pending. The *pending dialog's kind* is carried forward as
 * `overlay.dialogKind` so the content builder can tailor the heading.
 */
const promoteQuickHelp = (
  base: HostOverlay | undefined,
  quickHelp: HostAppState["quickHelp"],
): HostOverlay | undefined => {
  if (quickHelp === undefined) {
    return base;
  }
  const inheritedKind = quickHelp.dialogKind ?? base?.kind;
  return inheritedKind === undefined
    ? { kind: "quick_help", context: quickHelp.context }
    : { kind: "quick_help", context: quickHelp.context, dialogKind: inheritedKind };
};

export const selectRenderFrame = (inputs: FrameInputs): RenderFrame => {
  const { state, transcript, repoLabel } = inputs;
  const head = state.promptQueue[0];
  const baseOverlay = deriveOverlay(head, state);
  const overlay = promoteQuickHelp(baseOverlay, state.quickHelp);
  const hasOverlay = overlay !== undefined;
  const offTranscript = state.screen !== "transcript";
  const mode: FrameMode = hasOverlay || offTranscript ? "transcript" : "prompt";
  const hints = footerHintsFor(state, overlay);

  const frame: RenderFrame = {
    mode,
    header: {
      title: "Bakudo",
      mode: state.composer.mode,
      sessionLabel: sessionLabelFor(state.activeSessionId, state.activeTurnId),
      ...(repoLabel !== undefined ? { repoLabel } : {}),
    },
    transcript,
    footer: { hints },
    composer: {
      placeholder: "",
      mode: state.composer.mode,
      autoApprove: state.composer.autoApprove,
    },
  };
  if (overlay !== undefined) {
    frame.overlay = overlay;
  }
  return frame;
};
