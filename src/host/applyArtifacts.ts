import type { ArtifactStore } from "../artifactStore.js";
import { writeSessionArtifact } from "./sessionArtifactWriter.js";
import type { ArtifactKind } from "./artifactStore.js";

export type ApplyArtifactContext = {
  artifactStore: ArtifactStore;
  storageRoot: string;
  sessionId: string;
  turnId: string;
  attemptId: string;
};

const applyMetadata = (role: string, extra?: Record<string, unknown>): Record<string, unknown> => ({
  generatedBy: "host.candidateApplier",
  producer: "host.candidateApplier",
  phase: "apply",
  role,
  ...(extra ?? {}),
});

const writeApplyArtifact = async (
  context: ApplyArtifactContext,
  name: string,
  contents: string,
  kind: ArtifactKind,
  role: string,
  extra?: Record<string, unknown>,
): Promise<string> => {
  await writeSessionArtifact(
    context.artifactStore,
    context.storageRoot,
    context.sessionId,
    context.turnId,
    context.attemptId,
    name,
    contents,
    kind,
    applyMetadata(role, extra),
  );
  return name;
};

export const writeApplyJsonArtifact = async (
  context: ApplyArtifactContext,
  name: string,
  payload: unknown,
  role: string,
  extra?: Record<string, unknown>,
): Promise<string> =>
  writeApplyArtifact(
    context,
    name,
    `${JSON.stringify(payload, null, 2)}\n`,
    "report",
    role,
    extra,
  );

export const writeApplyPatchArtifact = async (
  context: ApplyArtifactContext,
  name: string,
  patch: string,
  role: string,
  extra?: Record<string, unknown>,
): Promise<string> =>
  writeApplyArtifact(context, name, patch, "patch", role, {
    patchBytes: Buffer.byteLength(patch, "utf8"),
    ...(extra ?? {}),
  });

export const writeApplyTextArtifact = async (
  context: ApplyArtifactContext,
  name: string,
  contents: string,
  role: string,
  extra?: Record<string, unknown>,
): Promise<string> => writeApplyArtifact(context, name, contents, "summary", role, extra);
