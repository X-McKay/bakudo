import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { z } from "zod";

/**
 * Minimal append-only NDJSON helpers shared by records that don't need the
 * buffered/retrying semantics of {@link src/host/eventLogWriter.ts} — e.g.
 * per-session approval records, provenance records, future
 * single-record-per-lifecycle stores.
 *
 * Write shape: one JSON document per line, trailing newline, append mode.
 * Read shape: blank lines skipped, ENOENT yields `[]`. Optional Zod schema
 * runs per-line to reject garbage early.
 */

/**
 * Append a single record to `filePath` as one NDJSON line. Creates the
 * parent directory on first write. Each call does its own open-write-close;
 * a single call is atomic w.r.t. one line, but concurrent calls from the
 * same process may interleave lines (the reader deduplicates via the
 * caller's ID semantics if that matters).
 */
export const appendNdjsonLine = async (filePath: string, record: unknown): Promise<void> => {
  await mkdir(dirname(filePath), { recursive: true });
  const line = `${JSON.stringify(record)}\n`;
  await appendFile(filePath, line, { encoding: "utf8" });
};

/**
 * Read a whole NDJSON file into an array of parsed records. Returns `[]`
 * when the file doesn't exist. Blank lines are skipped. When `schema` is
 * provided, each non-blank line is validated through it — a schema error
 * aborts the read with the usual Zod throw, so callers opting into
 * validation fail fast on corruption.
 */
export const readNdjsonFile = async <T>(filePath: string, schema?: z.ZodType<T>): Promise<T[]> => {
  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const lines = content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (schema !== undefined) {
    return lines.map((line) => schema.parse(JSON.parse(line)));
  }
  return lines.map((line) => JSON.parse(line) as T);
};
