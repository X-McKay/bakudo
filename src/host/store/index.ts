import type { HostAppState } from "../appState.js";
import type { HostAction } from "../reducer.js";

export type Reducer = (state: HostAppState, action: HostAction) => HostAppState;
export type Subscriber = () => void;

export type HostStore = {
  getSnapshot(): HostAppState;
  subscribe(fn: Subscriber): () => void;
  dispatch(action: HostAction): void;
};

export const createHostStore = (
  reducer: Reducer,
  initialState: HostAppState,
): HostStore => {
  let state = initialState;
  const subscribers = new Set<Subscriber>();

  return {
    getSnapshot: () => state,
    subscribe: (fn) => {
      subscribers.add(fn);
      return () => {
        subscribers.delete(fn);
      };
    },
    dispatch: (action) => {
      const next = reducer(state, action);
      if (next === state) return;
      state = next;
      for (const fn of subscribers) fn();
    },
  };
};
