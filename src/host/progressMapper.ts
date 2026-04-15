import type { WorkerTaskProgressEvent } from "../workerRuntime.js";

export type ProgressStage =
  | "queued"
  | "started"
  | "running_output"
  | "timed_out"
  | "completed"
  | "failed";

export type ProgressTone = "info" | "success" | "warning" | "error";

export type ProgressMapping = {
  stage: ProgressStage;
  line?: string;
  tone?: ProgressTone;
};

/**
 * Map a low-level worker progress event to a single transcript narration line.
 *
 * Phase 1 Workstream 7 — semantic progress mapper.
 *
 * Coalescence rule: when the worker emits repeated `task.progress` events while
 * still running, only the first transition into {@link ProgressStage}
 * "running_output" emits a line. Subsequent running events at the same stage
 * return a mapping with no `line`, leaving the transcript quiet.
 *
 * Escalation rule: a `task.progress` event carrying `timedOut=true` escalates
 * to the {@link ProgressStage} "timed_out" stage regardless of the prior stage,
 * and always emits its warning line.
 */
export const mapWorkerEventToNarration = (
  event: WorkerTaskProgressEvent,
  lastStage?: ProgressStage,
): ProgressMapping => {
  switch (event.kind) {
    case "task.queued":
      return { stage: "queued", line: "Queued sandbox attempt.", tone: "info" };
    case "task.started":
      return { stage: "started", line: "Sandbox worker started.", tone: "info" };
    case "task.progress": {
      if (event.timedOut === true) {
        return {
          stage: "timed_out",
          line: "Worker hit its timeout and is being stopped.",
          tone: "warning",
        };
      }
      if (lastStage === "running_output") {
        return { stage: "running_output" };
      }
      return {
        stage: "running_output",
        line: "Worker is producing output.",
        tone: "info",
      };
    }
    case "task.completed":
      return {
        stage: "completed",
        line: "Worker completed. Reviewing result.",
        tone: "info",
      };
    case "task.failed":
      return {
        stage: "failed",
        line: "Worker failed. Reviewing result.",
        tone: "error",
      };
    // task.checkpoint and any future kinds: no emission; preserve last stage.
    default:
      return { stage: lastStage ?? "queued" };
  }
};

/**
 * Priority ranking for stages used by the coalescer to choose which stage
 * "wins" when multiple events land inside a single tick window.
 *
 * `timed_out` and `failed` are terminal and must never be overridden by a
 * later same-tick running or completed event.
 */
export const progressStagePriority: Record<ProgressStage, number> = {
  queued: 0,
  started: 1,
  running_output: 2,
  completed: 3,
  timed_out: 4,
  failed: 5,
};

export const isTerminalStage = (stage: ProgressStage): boolean =>
  stage === "timed_out" || stage === "failed" || stage === "completed";
