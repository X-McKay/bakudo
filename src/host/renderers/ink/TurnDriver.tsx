import React, { useEffect, useRef } from "react";
import { useAppState } from "./hooks/useAppState.js";
import { useStore } from "./StoreProvider.js";

export type RunTurn = (text: string, signal: AbortSignal) => Promise<void>;

export const TurnDriver = ({ runTurn }: { runTurn: RunTurn }) => {
  const store = useStore();
  const pending = useAppState((s) => s.pendingSubmit);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!pending) return;
    const ac = new AbortController();
    abortRef.current = ac;
    (async () => {
      try {
        await runTurn(pending.text, ac.signal);
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        store.dispatch({
          type: "append_assistant",
          text: `Error: ${message}`,
          tone: "error",
        });
      } finally {
        store.dispatch({ type: "dispatch_finished" });
        store.dispatch({ type: "clear_pending_submit" });
      }
    })();
    return () => ac.abort();
  }, [pending?.seq, runTurn, store]);

  return null;
};
