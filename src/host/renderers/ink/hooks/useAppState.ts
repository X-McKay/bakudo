import { useSyncExternalStore } from "react";
import type { HostAppState } from "../../../appState.js";
import { useStore } from "../StoreProvider.js";

export function useAppState<T>(selector: (s: HostAppState) => T): T {
  const store = useStore();
  return useSyncExternalStore(
    store.subscribe,
    () => selector(store.getSnapshot()),
    () => selector(store.getSnapshot()),
  );
}
