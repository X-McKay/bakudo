import type { ComposerMode, HostAppState } from "./appState.js";

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

export const selectRenderFrame = (inputs: FrameInputs): RenderFrame => {
  const { state, transcript, repoLabel } = inputs;
  const hasOverlay = state.overlay !== undefined;
  const offTranscript = state.screen !== "transcript";
  const mode: FrameMode = hasOverlay || offTranscript ? "transcript" : "prompt";

  const hints = state.activeSessionId ? ["[inspect]", "[help]"] : ["[help]"];

  return {
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
};
