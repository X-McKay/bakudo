import type { TranscriptItem } from "./renderModel.js";
import type { HostStore } from "./store/index.js";

// Map each TranscriptItem kind to the reducer action it dispatches. Lifted
// out of `push()` so it's allocated once per shell session, not once per call.
const kindToAction = {
  user: (i: TranscriptItem & { kind: "user" }) =>
    ({
      type: "append_user",
      text: i.text,
      ...(i.timestamp ? { timestamp: i.timestamp } : {}),
    }) as const,
  assistant: (i: TranscriptItem & { kind: "assistant" }) =>
    ({
      type: "append_assistant",
      text: i.text,
      ...(i.tone ? { tone: i.tone } : {}),
    }) as const,
  event: (i: TranscriptItem & { kind: "event" }) =>
    ({
      type: "append_event",
      label: i.label,
      ...(i.detail ? { detail: i.detail } : {}),
    }) as const,
  output: (i: TranscriptItem & { kind: "output" }) =>
    ({ type: "append_output", text: i.text }) as const,
  review: (i: TranscriptItem & { kind: "review" }) => ({
    type: "append_review" as const,
    outcome: i.outcome,
    summary: i.summary,
    ...(i.nextAction ? { nextAction: i.nextAction } : {}),
  }),
} as const;

export type TranscriptFacade = {
  push(item: TranscriptItem): number;
  get length(): number;
  set length(n: number);
  [Symbol.iterator](): IterableIterator<TranscriptItem>;
};

export const buildTranscriptFacade = (store: HostStore): TranscriptFacade => ({
  push(item: TranscriptItem): number {
    const action = kindToAction[item.kind](item as never);
    store.dispatch(action);
    return store.getSnapshot().transcript.length;
  },
  get length(): number {
    return store.getSnapshot().transcript.length;
  },
  set length(n: number) {
    if (n !== 0) {
      throw new Error(`transcriptFacade.length can only be set to 0 (got ${n})`);
    }
    store.dispatch({ type: "clear_transcript" });
  },
  [Symbol.iterator](): IterableIterator<TranscriptItem> {
    return store.getSnapshot().transcript[Symbol.iterator]();
  },
});
