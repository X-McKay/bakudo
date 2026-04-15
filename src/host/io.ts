import type { Readable, Writable } from "node:stream";

export type HostIo = {
  stdin?: Readable;
  stdout?: Writable;
  stderr?: Writable;
};

export type TextWriter = {
  write(data: string | Uint8Array): unknown;
};

export const runtimeIo = process as unknown as HostIo;

let activeStdoutWriter: TextWriter | undefined;

const baseStdout = (): TextWriter =>
  (runtimeIo.stdout as TextWriter | undefined) ?? (process.stdout as TextWriter);

export const getBaseStdout = (): TextWriter => baseStdout();

export const stdoutWrite = (text: string): void => {
  void (activeStdoutWriter ?? baseStdout()).write(text);
};

export const stderrWrite = (text: string): void => {
  void (runtimeIo.stderr ?? process.stderr).write(text);
};

export const withCapturedStdout = async <T>(
  writer: TextWriter,
  fn: () => Promise<T>,
): Promise<T> => {
  const prior = activeStdoutWriter;
  activeStdoutWriter = writer;
  try {
    return await fn();
  } finally {
    activeStdoutWriter = prior;
  }
};
