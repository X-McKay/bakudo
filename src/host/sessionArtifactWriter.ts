import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ArtifactStore } from "../artifactStore.js";
import type { TaskResult } from "../protocol.js";
import { sanitizePathSegment } from "../sessionStore.js";
import type { SessionReviewAction, SessionReviewOutcome } from "../sessionTypes.js";

export const writeSessionArtifact = async (
  artifactStore: ArtifactStore,
  sessionId: string,
  taskId: string,
  name: string,
  contents: string,
  kind: string,
  metadata?: Record<string, unknown>,
): Promise<void> => {
  const artifactsDir = artifactStore.artifactDir(sessionId);
  await mkdir(artifactsDir, { recursive: true });
  const safeName = `${sanitizePathSegment(taskId)}-${name}`;
  const filePath = join(artifactsDir, safeName);
  await writeFile(filePath, contents, "utf8");
  await artifactStore.registerArtifact({
    artifactId: `${taskId}:${name}`,
    sessionId,
    taskId,
    kind,
    name,
    path: filePath,
    ...(metadata === undefined ? {} : { metadata }),
  });
};

export type ExecutionArtifactBundle = {
  artifactStore: ArtifactStore;
  sessionId: string;
  taskId: string;
  result: TaskResult;
  rawOutput: string;
  ok: boolean;
  workerErrorCount: number;
  sandboxTaskId: unknown;
  aboxCommand: unknown;
  reviewedOutcome: SessionReviewOutcome;
  reviewedAction: SessionReviewAction;
};

export const writeExecutionArtifacts = async (bundle: ExecutionArtifactBundle): Promise<void> => {
  await writeSessionArtifact(
    bundle.artifactStore,
    bundle.sessionId,
    bundle.taskId,
    "result.json",
    `${JSON.stringify(bundle.result, null, 2)}\n`,
    "result",
    { outcome: bundle.reviewedOutcome },
  );
  await writeSessionArtifact(
    bundle.artifactStore,
    bundle.sessionId,
    bundle.taskId,
    "worker-output.log",
    `${bundle.rawOutput}\n`,
    "log",
    { ok: bundle.ok, errorCount: bundle.workerErrorCount },
  );
  await writeSessionArtifact(
    bundle.artifactStore,
    bundle.sessionId,
    bundle.taskId,
    "dispatch.json",
    `${JSON.stringify(
      {
        sandboxTaskId: bundle.sandboxTaskId,
        aboxCommand: bundle.aboxCommand,
        reviewedOutcome: bundle.reviewedOutcome,
        reviewedAction: bundle.reviewedAction,
      },
      null,
      2,
    )}\n`,
    "dispatch",
  );
};
