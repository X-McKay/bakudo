import type { ApprovalPromptRequest } from "../appState.js";
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
 * - Cursor pins to `[1]`. Shift+Tab navigation is a Phase 5 keybinding
 *   concern (see TODO below).
 */
// TODO(phase5): wire Shift+Tab to cycle the ❯ cursor through [1][2][3][4].
//   Phase 4 ships the cursor at the default position; keybinding plumbing
//   belongs with the rest of the rich-TUI work in Phase 5.
export const renderApprovalPromptLines = (request: ApprovalPromptRequest): string[] => {
  const displayCommand = renderPermissionDisplayCommand(request.tool, request.argument);
  // `PermissionTool = KnownPermissionTool | (string & {})` so `request.tool`
  // is structurally assignable without a cast.
  const pattern = suggestAllowAlwaysPattern(request.tool, request.argument);
  const agent = request.policySnapshot.agent;
  return [
    `Bakudo: Worker wants to run: ${displayCommand}`,
    `Bakudo: This matches no existing allow rule in agent=${agent}.`,
    "",
    "  \u276F [1] allow once",
    `    [2] allow always for ${request.tool}(${pattern})`,
    "    [3] deny",
    "    [4] show context (inspect attempt spec)",
    "",
    "Choice [1/2/3/4] (Shift+Tab to go back):",
  ];
};
