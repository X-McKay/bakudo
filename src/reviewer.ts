import type { TaskResult } from "./protocol.js";
import {
  classifyReviewedOutcome,
  type ReviewClassification,
  type ReviewClassifierHints,
} from "./resultClassifier.js";

export type ReviewedTaskResult = ReviewClassification & {
  taskId: string;
  sessionId: string;
  status: TaskResult["status"];
  result: TaskResult;
};

export const reviewTaskResult = (
  result: TaskResult,
  hints: ReviewClassifierHints = {},
): ReviewedTaskResult => {
  const classification = classifyReviewedOutcome(result, hints);
  return {
    ...classification,
    taskId: result.taskId,
    sessionId: result.sessionId,
    status: result.status,
    result,
  };
};
