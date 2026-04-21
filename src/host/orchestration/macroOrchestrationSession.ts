/**
 * MacroOrchestrationSession
 *
 * A persistent, long-lived Claude Code / Codex process that serves as the
 * macro-orchestration brain for the bakudo interactive shell.
 *
 * ## Architecture
 *
 * One `MacroOrchestrationSession` is created when `runInteractiveShell()`
 * starts and torn down when it exits. Every macro-level reasoning task —
 * routing classification, pre-flight clarification, objective decomposition,
 * steering interpretation, and status narration — is a new turn in this single
 * persistent conversation.
 *
 * The session never writes files or runs shell commands. It only reasons and
 * returns structured JSON. All execution (code writing, testing, git commits)
 * is delegated to abox-sandboxed agents via `OrchestratorDriver`.
 *
 * ## Turn protocol
 *
 * Each turn is a JSON envelope sent to the process stdin:
 *
 *   { "task": "<task_type>", "payload": { ... } }
 *
 * The process responds with a JSON envelope on stdout:
 *
 *   { "task": "<task_type>", "result": { ... } }
 *
 * The session buffers stdout until it receives a complete JSON object
 * (detected by balanced brace counting), then resolves the pending turn.
 *
 * ## Context replay on reconnect
 *
 * If the underlying process dies mid-session (crash, OOM, network drop),
 * `MacroOrchestrationSession` automatically restarts it and replays a rolling
 * summary of the last N turns as a system message so the model has enough
 * context to continue coherently.
 *
 * ## System prompt
 *
 * The session is initialised with a system prompt that:
 * 1. Describes bakudo's architecture (macro layer vs. abox execution layer).
 * 2. Lists all task types and their expected JSON schemas.
 * 3. Establishes the constraint that the macro layer NEVER writes files.
 * 4. Gives the model the full conversation history so far (on reconnect).
 *
 * ## Dependency injection
 *
 * The `SpawnFn` is injected so tests can stub the process without spawning a
 * real Claude Code / Codex binary.
 */

import { spawn as nodeSpawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type { ProviderSpec } from "../providerRegistry.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type SpawnFn = typeof nodeSpawn;

/** A single turn in the macro session conversation history. */
export type MacroTurn = {
  readonly task: string;
  readonly userPayload: Record<string, unknown>;
  readonly modelResult: Record<string, unknown>;
};

/** Dependencies required to create a MacroOrchestrationSession. */
export type MacroSessionDeps = {
  provider: ProviderSpec;
  spawn?: SpawnFn;
  /** Maximum number of prior turns to include in context replay. Defaults to 20. */
  maxReplayTurns?: number;
};

// ---------------------------------------------------------------------------
// Task schemas (for documentation — enforced by the system prompt)
// ---------------------------------------------------------------------------

export type ClassifyTask = {
  task: "classify";
  payload: { text: string; hasActiveObjective: boolean };
};

export type ClarifyTask = {
  task: "clarify";
  payload: { goal: string };
};

export type DecomposeTask = {
  task: "decompose";
  payload: { goal: string; repoContext?: string };
};

export type SteerTask = {
  task: "steer";
  payload: { command: string; activeCampaigns: string[] };
};

export type StatusTask = {
  task: "status";
  payload: { orchestratorState: Record<string, unknown> };
};

export type MacroTask =
  | ClassifyTask
  | ClarifyTask
  | DecomposeTask
  | SteerTask
  | StatusTask;

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are the macro-orchestration brain of bakudo, a terminal AI coding assistant.

## Your role

You handle ALL reasoning and planning. You NEVER write files, run shell commands, or modify the repository. Those tasks are delegated to sandboxed abox agents.

## Architecture

- **Macro layer (you)**: Routing, clarification, decomposition, steering, narration. Pure reasoning only.
- **Micro layer (abox agents)**: Code writing, testing, git commits, synthesis. Execution only.

## Turn protocol

You receive a JSON envelope on stdin:
  { "task": "<task_type>", "payload": { ... } }

You respond with a JSON envelope on stdout, on a single line, with no other text:
  { "task": "<task_type>", "result": { ... } }

CRITICAL: Respond ONLY with the JSON envelope. No preamble, no explanation, no markdown fences.

## Task types and schemas

### classify
Classify the user's message into one of four routing categories.

Input payload:
  { "text": string, "hasActiveObjective": boolean }

Result schema:
  { "classification": "simple" | "complex" | "status_query" | "steering_command" }

Categories:
- "simple": Question, lookup, single-shot task, slash command, or anything answerable without decomposition.
- "complex": Multi-step engineering goal requiring parallel campaign decomposition.
- "status_query": User asking about progress of a running/completed objective.
- "steering_command": Mid-run directive to modify/abort the active objective. Only valid when hasActiveObjective is true; otherwise classify as "simple".

### clarify
Decide whether a complex goal needs clarification before decomposition.

Input payload:
  { "goal": string }

Result schema:
  { "needsClarification": false }
  OR
  { "needsClarification": true, "question": string }

A goal needs clarification if it is vague, uses pronouns without clear referents, or has multiple valid interpretations that would lead to very different implementations.

### decompose
Break a complex goal into parallel implementation campaigns.

Input payload:
  { "goal": string, "repoContext"?: string }

Result schema:
  {
    "campaigns": [
      { "id": string, "description": string, "priority": number, "dependsOn": string[] }
    ]
  }

Each campaign is an independent, parallelisable unit of work. Campaigns that depend on others must list their dependencies in "dependsOn".

### steer
Interpret a mid-run steering command and produce a concrete action plan.

Input payload:
  { "command": string, "activeCampaigns": string[] }

Result schema:
  {
    "action": "skip" | "abort" | "reprioritise" | "focus" | "pause" | "resume",
    "targetCampaigns": string[],
    "acknowledgement": string
  }

### status
Generate a prose status summary from the current orchestrator state.

Input payload:
  { "orchestratorState": object }

Result schema:
  { "summary": string }

The summary should be warm, first-person, and conversational — like a collaborator giving a verbal update.

## Conversation history

You have full context of this bakudo session. Use it to:
- Understand references to prior turns ("same reason as last time", "like we discussed")
- Avoid repeating clarifying questions already answered
- Provide continuity in status summaries
- Make steering interpretations that respect earlier decisions`;

// ---------------------------------------------------------------------------
// MacroOrchestrationSession
// ---------------------------------------------------------------------------

export class MacroOrchestrationSession {
  private readonly deps: Required<MacroSessionDeps>;
  private process: ChildProcess | null = null;
  private readonly history: MacroTurn[] = [];
  private pendingResolve: ((value: string) => void) | null = null;
  private pendingReject: ((reason: unknown) => void) | null = null;
  private stdoutBuffer = "";
  private braceDepth = 0;
  private inString = false;
  private escape = false;

  constructor(deps: MacroSessionDeps) {
    this.deps = {
      spawn: nodeSpawn,
      maxReplayTurns: 20,
      ...deps,
    };
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Start the underlying Claude Code / Codex process.
   * Must be called before any `send()` calls.
   * Idempotent — safe to call if already started.
   */
  public start(): void {
    if (this.process !== null) {
      return;
    }
    this.spawnProcess();
  }

  /**
   * Tear down the underlying process gracefully.
   * Any in-flight turn will be rejected.
   */
  public dispose(): void {
    if (this.process === null) {
      return;
    }
    this.pendingReject?.(new Error("MacroOrchestrationSession disposed"));
    this.pendingResolve = null;
    this.pendingReject = null;
    try {
      this.process.stdin?.end();
      this.process.kill("SIGTERM");
    } catch {
      // Best-effort teardown.
    }
    this.process = null;
    this.stdoutBuffer = "";
    this.braceDepth = 0;
    this.inString = false;
    this.escape = false;
  }

  // ---------------------------------------------------------------------------
  // Turn dispatch
  // ---------------------------------------------------------------------------

  /**
   * Send a task to the macro session and await the result.
   * Automatically restarts the process with context replay if it has died.
   */
  public async send<T extends Record<string, unknown>>(
    task: MacroTask,
  ): Promise<T> {
    if (this.process === null || !this.isAlive()) {
      this.spawnProcess(true /* replay */);
    }

    const envelope = JSON.stringify({ task: task.task, payload: task.payload });
    const raw = await this.writeAndAwait(envelope);

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      throw new Error(`MacroOrchestrationSession: invalid JSON response: ${raw}`);
    }

    const result = parsed["result"] as T | undefined;
    if (result === undefined) {
      throw new Error(
        `MacroOrchestrationSession: response missing "result" field: ${raw}`,
      );
    }

    // Record in history for context replay.
    this.history.push({
      task: task.task,
      userPayload: task.payload,
      modelResult: result,
    });

    return result;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private isAlive(): boolean {
    return (
      this.process !== null &&
      this.process.exitCode === null &&
      this.process.signalCode === null
    );
  }

  private spawnProcess(replay = false): void {
    const { provider, spawn } = this.deps;

    const child = spawn(provider.command[0]!, provider.command.slice(1), {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    this.process = child;
    this.stdoutBuffer = "";
    this.braceDepth = 0;
    this.inString = false;
    this.escape = false;

    child.stdout?.on("data", (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      this.onStdout(text);
    });

    child.once("error", (err) => {
      this.pendingReject?.(new Error(`MacroOrchestrationSession process error: ${err.message}`));
      this.pendingResolve = null;
      this.pendingReject = null;
      this.process = null;
    });

    child.once("close", (code) => {
      if (this.pendingReject !== null) {
        this.pendingReject(
          new Error(`MacroOrchestrationSession process exited with code ${code ?? "null"}`),
        );
        this.pendingResolve = null;
        this.pendingReject = null;
      }
      this.process = null;
    });

    // Send the system prompt (with optional context replay) as the first message.
    const initMessage = this.buildInitMessage(replay);
    child.stdin?.write(initMessage + "\n", "utf8");
  }

  private buildInitMessage(replay: boolean): string {
    let prompt = SYSTEM_PROMPT;

    if (replay && this.history.length > 0) {
      const replayTurns = this.history.slice(-this.deps.maxReplayTurns);
      const historyText = replayTurns
        .map(
          (t, i) =>
            `Turn ${i + 1} — task: ${t.task}\n  Input: ${JSON.stringify(t.userPayload)}\n  Result: ${JSON.stringify(t.modelResult)}`,
        )
        .join("\n\n");
      prompt += `\n\n## Session history (last ${replayTurns.length} turns)\n\n${historyText}`;
    }

    return JSON.stringify({ task: "init", payload: { systemPrompt: prompt } });
  }

  private writeAndAwait(envelope: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      if (this.process === null) {
        reject(new Error("MacroOrchestrationSession: process not started"));
        return;
      }
      this.pendingResolve = resolve;
      this.pendingReject = reject;
      this.stdoutBuffer = "";
      this.braceDepth = 0;
      this.inString = false;
      this.escape = false;
      this.process.stdin?.write(envelope + "\n", "utf8");
    });
  }

  /**
   * Stream-parse stdout to detect when a complete top-level JSON object has
   * been received. Uses a character-by-character brace-depth counter that
   * correctly handles strings (including escaped quotes).
   */
  private onStdout(chunk: string): void {
    for (const ch of chunk) {
      this.stdoutBuffer += ch;

      if (this.escape) {
        this.escape = false;
        continue;
      }

      if (ch === "\\" && this.inString) {
        this.escape = true;
        continue;
      }

      if (ch === '"') {
        this.inString = !this.inString;
        continue;
      }

      if (this.inString) {
        continue;
      }

      if (ch === "{") {
        this.braceDepth++;
      } else if (ch === "}") {
        this.braceDepth--;
        if (this.braceDepth === 0 && this.stdoutBuffer.trim().startsWith("{")) {
          // Complete top-level JSON object received.
          const complete = this.stdoutBuffer.trim();
          this.stdoutBuffer = "";
          this.braceDepth = 0;
          this.inString = false;
          this.escape = false;
          this.pendingResolve?.(complete);
          this.pendingResolve = null;
          this.pendingReject = null;
        }
      }
    }
  }
}
