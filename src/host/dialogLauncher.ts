import type { ComposerMode, HostAppState, PromptEntry } from "./appState.js";
import { reduceHost, type HostAction } from "./reducer.js";
import { answerPrompt, awaitPrompt, newPromptId } from "./promptResolvers.js";

/**
 * Phase 4 PR7 — Promise-based dialog launcher surface.
 *
 * Motivation (plan §A4.1 "Promise-Based Dialog Launchers"):
 *
 * 1. **Coroutine flow.** Callers write `const decision = await launchApprovalDialog(req)`
 *    instead of registering callbacks. Composes naturally with `for ... of`
 *    and conditionals.
 * 2. **Mutual exclusion with the queue.** Each launcher submits to the
 *    existing `promptQueue`; overlays render from `promptQueue[0]` only, so
 *    a second launch while one is active queues and blocks — no concurrent
 *    dialogs.
 *
 * The approval launcher is the Phase 4 producer. Recovery and session-picker
 * launchers are typed stubs so future phases can drop in implementations
 * without redesigning the signature.
 */

// ---------------------------------------------------------------------------
// Public request/response shapes
// ---------------------------------------------------------------------------

export type ApprovalRequest = {
  sessionId: string;
  turnId: string;
  attemptId?: string;
  /** Tool identifier, e.g. `"shell"`. Mirrors `PermissionTool`. */
  tool: string;
  /** Raw argument, e.g. `"git push origin main"`. */
  argument: string;
  policySnapshot: {
    agent: string;
    composerMode: ComposerMode;
    autopilot: boolean;
  };
};

export type ApprovalDialogChoice =
  | { kind: "allow_once" }
  | { kind: "allow_always"; pattern: string }
  | { kind: "deny" }
  | { kind: "show_context" };

/**
 * Minimal dispatcher surface. Callers pass in a shim that owns the
 * host-app-state reducer. We do not import any render loop — the launcher
 * stays a pure producer onto `promptQueue`.
 */
export type DialogDispatcher = {
  getState: () => HostAppState;
  setState: (next: HostAppState) => void;
};

// ---------------------------------------------------------------------------
// Non-interactive toggle — `--no-ask-user` (Phase 5 PR11)
// ---------------------------------------------------------------------------

/**
 * Module-scoped flag backing the `--no-ask-user` CLI option. When `true`,
 * {@link launchApprovalDialog} throws instead of enqueuing an overlay.
 * Exposed as a setter (rather than a dialog argument) so every caller in
 * the approval pipeline picks up the same policy without plumbing the flag
 * through multiple hops. Callers MUST reset it between one-shot invocations
 * with {@link resetNoAskUser} to avoid state leaks in tests.
 */
let noAskUserEnabled = false;

export const setNoAskUser = (enabled: boolean): void => {
  noAskUserEnabled = enabled;
};

export const isNoAskUserEnabled = (): boolean => noAskUserEnabled;

export const resetNoAskUser = (): void => {
  noAskUserEnabled = false;
};

/**
 * Format the error message thrown when `--no-ask-user` would otherwise open
 * an interactive dialog. Kept as a pure helper so tests can assert on the
 * exact string and future callers (recovery dialog, session picker) can
 * share the format.
 */
export const noAskUserErrorMessage = (tool: string, argument: string): string =>
  `--no-ask-user: approval required for ${tool}(${argument})`;

// ---------------------------------------------------------------------------
// Approval dialog — the real producer
// ---------------------------------------------------------------------------

const CHOICE_BY_CODE: ReadonlyMap<string, "allow_once" | "allow_always" | "deny" | "show_context"> =
  new Map([
    ["1", "allow_once"],
    ["2", "allow_always"],
    ["3", "deny"],
    ["4", "show_context"],
  ] as const);

/**
 * Parse the raw string resolution the interactive loop delivers into a
 * `ApprovalDialogChoice`. The resolver convention is a single digit 1-4.
 * Unknown/empty values default to `deny` — the safer fallback.
 *
 * `allow_always` needs the suggested pattern passed through so the caller
 * can persist the rule. The pattern is computed by the caller before enqueue
 * and stored on the payload; the choice resolver only forwards it.
 */
export const parseApprovalChoice = (raw: string, pattern: string): ApprovalDialogChoice => {
  const code = CHOICE_BY_CODE.get(raw.trim());
  if (code === "allow_once") {
    return { kind: "allow_once" };
  }
  if (code === "allow_always") {
    return { kind: "allow_always", pattern };
  }
  if (code === "show_context") {
    return { kind: "show_context" };
  }
  // Includes the explicit "3" path and all unknown input — deny is safe.
  return { kind: "deny" };
};

/**
 * Enqueue an `approval_prompt` onto `promptQueue` and return a promise that
 * resolves once the user picks one of `[1][2][3][4]`. The dialog is removed
 * from the queue before the promise resolves so follow-up launches can run.
 *
 * Composes with the existing `promptResolvers` module — mirrors the shape
 * used for `resume_confirm` in `src/host/commands/session.ts`.
 *
 * `suggestedPattern` is recomputed inside `parseApprovalChoice` via the same
 * helper the renderer calls, so both sides see the identical string without
 * passing it through the queue payload.
 */
export const launchApprovalDialog = async (
  dispatcher: DialogDispatcher,
  request: ApprovalRequest,
  suggestedPattern: string,
): Promise<ApprovalDialogChoice> => {
  if (noAskUserEnabled) {
    // Non-interactive mode: fail loudly with a deterministic message so
    // downstream orchestration surfaces the approval-gate hit via exit
    // code 2 (Phase 6 error taxonomy). No queue entry is created.
    throw new Error(noAskUserErrorMessage(request.tool, request.argument));
  }
  const id = newPromptId();
  // The payload IS the ApprovalPromptRequest — renderers read it verbatim.
  const entry: PromptEntry = { id, kind: "approval_prompt", payload: request };
  const enqueueAction: HostAction = { type: "enqueue_prompt", prompt: entry };
  dispatcher.setState(reduceHost(dispatcher.getState(), enqueueAction));
  try {
    const resolution = await awaitPrompt(id);
    if (resolution.kind !== "answered") {
      // Cancelled — treat as deny; see CHOICE_BY_CODE comment.
      return { kind: "deny" };
    }
    return parseApprovalChoice(resolution.value, suggestedPattern);
  } finally {
    const dequeueAction: HostAction = { type: "dequeue_prompt", id };
    dispatcher.setState(reduceHost(dispatcher.getState(), dequeueAction));
  }
};

/**
 * Test-facing hook: answer the head `approval_prompt` entry. Returns the
 * queue id that was resolved so tests can sanity-check the contract.
 */
export const answerApprovalDialog = (
  dispatcher: DialogDispatcher,
  choice: string,
): string | null => {
  const head = dispatcher.getState().promptQueue[0];
  if (head === undefined || head.kind !== "approval_prompt") {
    return null;
  }
  const ok = answerPrompt(head.id, choice);
  return ok ? head.id : null;
};

// ---------------------------------------------------------------------------
// Stub launchers — same shape, future phases implement
// ---------------------------------------------------------------------------

export type RecoveryRequest = {
  sessionId: string;
  turnId: string;
  reason: string;
};

export type RecoveryDialogChoice = { kind: "retry" } | { kind: "halt" } | { kind: "edit" };

/**
 * Planned for Phase 5 — retry/halt/edit after a failed attempt. Implementing
 * the shape now so callers can pre-wire `await launchRecoveryDialog(...)`
 * against the same `promptQueue`-backed mutual-exclusion contract.
 */
export const launchRecoveryDialog = async (
  _dispatcher: DialogDispatcher,
  _request: RecoveryRequest,
): Promise<RecoveryDialogChoice> => {
  // TODO(phase5): implement once the recovery UX is specced.
  throw new Error("launchRecoveryDialog: not implemented");
};

/**
 * Phase 5 PR7 — the real session-picker launcher ships in
 * `./launchSessionPickerDialog.ts`. The old `(purpose, excludeSessionId)`
 * request shape is superseded by an index-reader injection so the launcher
 * doesn't need to know where sessions live on disk.
 *
 * Re-exported here so legacy imports (`dialogLauncher.js`) keep working.
 */
export {
  answerSessionPickerDialog,
  buildSessionPickerItems,
  formatSessionPickerLabel,
  launchSessionPickerDialog,
  type SessionIndexReader,
  type SessionPickerDialogChoice,
} from "./launchSessionPickerDialog.js";

/**
 * Phase 5 PR7 — command palette launcher. See
 * `./launchCommandPaletteDialog.ts` for the implementation.
 */
export {
  answerCommandPaletteDialog,
  buildCommandPaletteItems,
  launchCommandPaletteDialog,
  type CommandPaletteDialogChoice,
} from "./launchCommandPaletteDialog.js";
