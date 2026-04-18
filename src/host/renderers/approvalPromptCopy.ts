import { APPROVAL_DIALOG_CURSOR_COUNT, type ApprovalPromptRequest } from "../appState.js";
import { renderPermissionDisplayCommand, suggestAllowAlwaysPattern } from "../approvalPolicy.js";

/**
 * Render the VERBATIM Phase 4 approval-prompt overlay. The exact copy is
 * specified in `plans/bakudo-ux/04-provenance-first-inspection-and-approval.md`
 * §"Approval Prompt UX" and echoed in `phase-4-record-design.md` §3.4:
 *
 *     Bakudo: Worker wants to run: <displayCommand>
 *     Bakudo: This matches no existing allow rule in agent=<agent>.
 *
 *       ❯ [1] allow once
 *         [2] allow always for <tool>(<suggested-pattern>)
 *         [3] deny
 *         [4] show context (inspect attempt spec)
 *
 *     Choice [1/2/3/4] (Shift+Tab to go back):
 *
 * Deliberate choices:
 *
 * - No tone/ANSI wrapping — tests assert exact strings, and the overlay
 *   mirrors into the plain (non-TTY) renderer which must stay colour-free.
 * - Autopilot state is NOT rendered — the dialog is only ever shown when
 *   the evaluator returns `"ask"`, which cannot happen under autopilot's
 *   `allow`-everything profile. Including it would suggest the user can
 *   toggle autopilot from this prompt, which they cannot.
 * - Phase 5 PR8 wires Shift+Tab to cycle the ❯ cursor through the four
 *   options. The caller drives `cursorIndex` (0 = [1] allow once, 1 = [2]
 *   allow always, 2 = [3] deny, 3 = [4] show context). Defaults to `0` so
 *   pre-PR8 callers keep the same output shape.
 */
export const renderApprovalPromptLines = (
  request: ApprovalPromptRequest,
  cursorIndex: number = 0,
): string[] => {
  const displayCommand = renderPermissionDisplayCommand(request.tool, request.argument);
  // `PermissionTool = KnownPermissionTool | (string & {})` so `request.tool`
  // is structurally assignable without a cast.
  const pattern = suggestAllowAlwaysPattern(request.tool, request.argument);
  const agent = request.policySnapshot.agent;
  const normalized = normalizeCursor(cursorIndex);
  const marker = (idx: number): string => (idx === normalized ? "  \u276F " : "    ");
  return [
    `Bakudo: Worker wants to run: ${displayCommand}`,
    `Bakudo: This matches no existing allow rule in agent=${agent}.`,
    "",
    `${marker(0)}[1] allow once`,
    `${marker(1)}[2] allow always for ${request.tool}(${pattern})`,
    `${marker(2)}[3] deny`,
    `${marker(3)}[4] show context (inspect attempt spec)`,
    "",
    "Choice [1/2/3/4] (Shift+Tab to go back):",
  ];
};

const normalizeCursor = (value: number): number => {
  if (!Number.isFinite(value)) {
    return 0;
  }
  const floored = Math.floor(value);
  if (floored < 0) {
    return 0;
  }
  if (floored >= APPROVAL_DIALOG_CURSOR_COUNT) {
    return APPROVAL_DIALOG_CURSOR_COUNT - 1;
  }
  return floored;
};
