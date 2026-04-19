type SetIntervalLike = (callback: () => void, delay: number) => unknown;
type ClearIntervalLike = (handle: unknown) => void;

export type DispatchProgressTicker = {
  start: () => void;
  stop: () => void;
};

export const startDispatchProgress = (input: {
  taskId: string;
  useJson: boolean;
  write: (line: string) => void;
  intervalMs?: number;
  now?: () => number;
  setIntervalFn?: SetIntervalLike;
  clearIntervalFn?: ClearIntervalLike;
}): DispatchProgressTicker => {
  if (input.useJson) {
    return { start: () => {}, stop: () => {} };
  }

  const intervalMs = input.intervalMs ?? 10_000;
  const now = input.now ?? Date.now;
  const setIntervalFn = input.setIntervalFn ?? ((callback, delay) => setInterval(callback, delay));
  const clearIntervalFn =
    input.clearIntervalFn ?? ((handle) => clearInterval(handle as NodeJS.Timeout));

  let startedAt = now();
  let handle: unknown;

  const writeProgress = (): void => {
    const elapsedSeconds = Math.floor((now() - startedAt) / 1000);
    input.write(
      `... dispatching ${input.taskId} (${elapsedSeconds}s elapsed, awaiting first worker event)\n`,
    );
  };

  return {
    start: () => {
      if (handle !== undefined) {
        return;
      }
      startedAt = now();
      handle = setIntervalFn(writeProgress, intervalMs);
    },
    stop: () => {
      if (handle === undefined) {
        return;
      }
      clearIntervalFn(handle);
      handle = undefined;
    },
  };
};
