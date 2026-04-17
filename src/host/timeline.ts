import { readFile } from "node:fs/promises";

import type { SessionEventEnvelope } from "../protocol.js";
import { eventLogFilePath, readSessionEventLog } from "./eventLogWriter.js";

/**
 * Minimal timeline surface for PR3. PR4 extends this with indexed query APIs
 * (by turn, by attempt, by actor). For now callers get either the parsed list
 * via {@link readSessionEventLog} or the enriched `LoadedEventLog` below.
 */

export type LoadedEventLog = {
  envelopes: SessionEventEnvelope[];
  malformedLineCount: number;
};

/**
 * Read the per-session event NDJSON, separating successfully parsed envelopes
 * from malformed/unparseable lines. Missing file → `{ envelopes: [],
 * malformedLineCount: 0 }`.
 */
export const loadEventLog = async (
  storageRoot: string,
  sessionId: string,
): Promise<LoadedEventLog> => {
  const filePath = eventLogFilePath(storageRoot, sessionId);
  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { envelopes: [], malformedLineCount: 0 };
    }
    throw error;
  }
  const envelopes: SessionEventEnvelope[] = [];
  let malformedLineCount = 0;
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) {
      continue;
    }
    try {
      envelopes.push(JSON.parse(line) as SessionEventEnvelope);
    } catch {
      malformedLineCount += 1;
    }
  }
  return { envelopes, malformedLineCount };
};

export { readSessionEventLog };
