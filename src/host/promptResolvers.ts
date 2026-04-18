import { randomUUID } from "node:crypto";

export type PromptResolution = { kind: "answered"; value: string } | { kind: "cancelled" };

type Resolver = (resolution: PromptResolution) => void;

const resolvers = new Map<string, Resolver>();

export const newPromptId = (): string => `prompt-${randomUUID()}`;

export const awaitPrompt = (id: string): Promise<PromptResolution> =>
  new Promise((resolve) => {
    resolvers.set(id, resolve);
  });

export const answerPrompt = (id: string, value: string): boolean => {
  const resolver = resolvers.get(id);
  if (resolver === undefined) {
    return false;
  }
  resolvers.delete(id);
  resolver({ kind: "answered", value });
  return true;
};

export const cancelPrompt = (id: string): boolean => {
  const resolver = resolvers.get(id);
  if (resolver === undefined) {
    return false;
  }
  resolvers.delete(id);
  resolver({ kind: "cancelled" });
  return true;
};

export const resetPromptResolvers = (): void => {
  resolvers.clear();
};

export const pendingPromptIds = (): string[] => Array.from(resolvers.keys());
