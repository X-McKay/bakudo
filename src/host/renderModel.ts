import type {
  ApprovalPromptRequest,
  CommandPaletteRequest,
  ComposerMode,
  HostAppState,
  HostOverlay,
  PromptEntry,
  SessionPickerPayload,
} from "./appState.js";

export type FrameMode = "prompt" | "transcript";

export type TranscriptItem =
  | { kind: "user"; text: string; timestamp?: string }
  | { kind: "assistant"; text: string; tone?: "info" | "success" | "warning" | "error" }
  | { kind: "event"; label: string; detail?: string }
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

const sessionLabelFor = (activeSessionId: string | undefined): string =>
  activeSessionId ? `session ${activeSessionId.slice(0, 8)}` : "no active session";

const deriveOverlay = (prompt: PromptEntry | undefined): HostOverlay | undefined => {
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
    return { kind: "approval_prompt", request };
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

export const selectRenderFrame = (inputs: FrameInputs): RenderFrame => {
  const { state, transcript, repoLabel } = inputs;
  const head = state.promptQueue[0];
  const overlay = deriveOverlay(head);
  const hasOverlay = overlay !== undefined;
  const offTranscript = state.screen !== "transcript";
  const mode: FrameMode = hasOverlay || offTranscript ? "transcript" : "prompt";

  const hints = state.activeSessionId ? ["[inspect]", "[help]"] : ["[help]"];

  const frame: RenderFrame = {
    mode,
    header: {
      title: "Bakudo",
      mode: state.composer.mode,
      sessionLabel: sessionLabelFor(state.activeSessionId),
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
