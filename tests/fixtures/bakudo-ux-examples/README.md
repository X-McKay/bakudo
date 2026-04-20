# Bakudo UX Golden Fixtures

Canonical reference output for the bakudo TUI, per Phase 6 Workstream 8
("Canonical Golden Examples — Required File List", lines 827-846 of
`/home/al/git/bakudo-abox/plans/bakudo-ux/06-rollout-reliability-and-operability.md`).

These are **planning artifacts**, not test inputs. Phase 6 Workstream 10
("Formalize PTY And Golden Test Maintenance") later wires them into real
tests under `bakudo/tests/golden/`. Reviewers compare implementation
output against these before approving any UX PR.

## Stable IDs Used Across Fixtures

To keep related fixtures internally consistent, the following synthetic
identifiers are reused:

| ID                         | Meaning                                                  |
|----------------------------|----------------------------------------------------------|
| `ses_01HXYZABCDEF01`       | Primary demo session (empty shell -> first prompt -> follow-up -> inspect) |
| `turn_01HXYZABCDEFT1`      | Turn 1 of the primary session                            |
| `turn_01HXYZABCDEFT2`      | Turn 2 (follow-up prompt in same session)                |
| `attempt_01HXYZABCDEFA1`   | Attempt 1 of turn 1 (succeeded)                          |
| `bakudo-ses_01HXYZABCDEF01-t1-a1` | Sandbox task ID for that attempt                  |
| `ses_01HXYZAUTO0101`       | Separate session for the autopilot one-shot fixture      |
| `chain_01HXYZCHAIN5`       | Retry chain for turn 5 in the lineage fixture            |
| `2026-05-01T12:00:00Z` ... | Base wall clock; all timestamps derive from this anchor  |

## File-to-Scenario Map

### 1. `empty-shell.tty.txt`
**Scenario:** Opening `bakudo` with no active session on a TTY.
Transcript-first empty state from Phase 1 Workstream 4 "Fresh Shell"
block. ANSI is minimal (bold + one brand color). Composer visible.

### 2. `empty-shell.plain.txt`
**Scenario:** Same empty-shell state under `--plain` / non-TTY /
`NO_COLOR=1`. All ANSI is stripped; identical semantic content as the
TTY variant.

### 3. `first-prompt-new-session.tty.txt`
**Scenario:** User's first plain-text prompt in a shell with no active
session. Per the Phase 1 truth table, this creates a session, turn 1,
and the first attempt. Transcript shows user line, assistant narration
(plan -> dispatch -> start -> output -> complete -> review), and the
`bakudo-…-t1-a1` sandbox dispatch line.

### 4. `follow-up-turn.tty.txt`
**Scenario:** Second plain-text prompt while session
`ses_01HXYZABCDEF01` is active. Continues the same session as turn 2;
narration says "Continuing session ..." and a new attempt is dispatched.
No new-session creation line.

### 5. `approval-prompt-shell-git.tty.txt`
**Scenario:** Worker requests `shell(git push origin main)` in standard
mode. No allow rule matches. Approval prompt shows the four choices
(once / always for `shell(git push:*)` / deny / inspect), copy verbatim
from Phase 4 Workstream "Approval Prompt UX" (lines 485-495).

### 6. `approval-prompt-network.tty.txt`
**Scenario:** Worker requests `network(api.github.com)` in standard
mode. Same dialog shape as the shell approval, but with
`network(*.github.com)` as the proposed "always" pattern.

### 7. `inspect-summary.tty.txt`
**Scenario:** `/inspect` with default `summary` tab for session
`ses_01HXYZABCDEF01` turn 1. Fields rendered in the Phase 1 W5 / Phase 4
W4 priority order: prompt -> outcome -> next -> attempt/sandbox ->
artifacts -> approvals -> logs entry points.

### 8. `inspect-provenance.tty.txt`
**Scenario:** `/inspect provenance` tab for the same attempt. Renders
the 8-section layout from Phase 4 W4 "Provenance Tab Layout": agent
profile, compiled attempt spec, abox dispatch command (as an array),
sandbox task ID + worktree, permission rule matches (in firing order),
approval timeline, env allowlist snapshot, exit details.

### 9. `inspect-retry-lineage.tty.txt`
**Scenario:** `/inspect retry` on a turn with multiple attempts. Reads
`TurnTransition[]` (Phase 2 W3) not attempt-array traversal. Shows the
vertical chain format from Phase 4: `attempt -> transition(reason,
chainId, depth) -> attempt`, terminating at the succeeding attempt.

### 10. `autopilot-run.plain.txt`
**Scenario:** `bakudo --plain --mode autopilot -p "..."` one-shot.
Autopilot narration in plain mode includes inline auto-approve /
auto-deny lines (each still creates a durable `ApprovalRecord`) and a
summary footer with inspect invocation. Exit code 0.

### 11. `protocol-mismatch-error.plain.txt`
**Scenario:** Host needs protocol v3; older abox reports protocol v1
only. `WorkerProtocolMismatchError` fires before dispatch, per Phase 6
"Worker Capability Probe Fallback". Exit code 4; stable error code
`worker_protocol_mismatch`. Plain-text rendering of the same condition
that `json-mode-error-envelope.json` encodes in JSON.

### 12. `json-mode-session-events.jsonl`
**Scenario:** `bakudo --output-format=json` capturing a full successful
turn (same session as fixtures 3, 7, 8). One `SessionEventEnvelope`
(Phase 2 W3) per line, covering: `user.turn_submitted`,
`host.turn_queued`, `host.plan_started`, `host.plan_completed`,
`host.approval_requested`, `host.approval_resolved`,
`host.dispatch_started`, `worker.attempt_started`,
`worker.attempt_progress` (×2, collapsed by progressMapper tick),
`worker.attempt_completed`, `host.artifact_registered` (×3),
`host.review_started`, `host.review_completed`.

### 13. `json-mode-error-envelope.json`
**Scenario:** A single top-level error envelope returned in JSON mode
for the protocol-mismatch condition. Shape is fixed by
`src/host/errors.ts::JsonErrorEnvelope` — top-level `{ok:false,
kind:"error", error:{code, message, details?}}` — and pins the stable
`code` string to the Phase 6 exit-code table entry for value `4`. Extra
metadata (exit code, occurredAt, remediation, session/turn/attempt)
lives inside `error.details` per lock-in 19.

### 14. `doctor-output.json`
**Scenario:** `bakudo doctor --output-format=json` on a healthy host.
Envelope shape fixed by `src/host/commands/doctor.ts::DoctorEnvelope`
(post Wave 6c PR7), including: `name`, `bakudoVersion`, `status`, full
`checks[]`, `node`, `abox` (capability-probe string), `rendererBackend`,
`agentProfile`, `configCascadePaths`, keybindings path + conflicts,
`terminal` capability, the new `telemetry` block (local-only OTel
status, spans-on-disk, `droppedEventBatches`, OTLP config), `uiMode`,
`storage` footprint + retention policy, and the effective-merged
`redaction` summary counts from `summarizeRedactionPolicy`.

## How To Regenerate (Future)

Do not auto-regenerate these fixtures in CI. Per Phase 6 W10, golden
updates must be explicit. Phase 6 Workstream 10 ships
`bakudo/tests/helpers/golden.ts` and an explicit regeneration command;
until then these files are hand-authored planning references.

## ANSI Legend

TTY fixtures render a minimal subset of ANSI for reviewer diff
readability. Escapes appear literally as `\e[...m` so that whitespace
and sequences are visually obvious in plain `diff` output. The PTY
comparator in Phase 6 W10 will translate this literal form to real
escape bytes before compare.

| Literal      | Effect                           |
|--------------|----------------------------------|
| `\e[1m`      | bold on                          |
| `\e[2m`      | dim on                           |
| `\e[32m`     | green (success outcome)          |
| `\e[31m`     | red (failed / blocked)           |
| `\e[33m`     | yellow (hint footer / ruler)     |
| `\e[36m`     | cyan (Bakudo brand prefix)       |
| `\e[0m`      | reset                            |
