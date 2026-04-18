# bakudo hooks

Hooks let bakudo dispatch external processes around lifecycle events so
you can run validators, notifiers, or custom gates without modifying
bakudo itself.

## Event names

Hooks subscribe by event name. The current set:

- `host.approval_requested` — fired when the host is about to gate on a
  permission prompt. Used for auto-approval policies.
- `host.approval_resolved` — fired after a decision is recorded.
- `host.provenance_started` — every dispatch emits one before running.
- `host.provenance_finalized` — every dispatch emits one after running.
- `user.turn_submitted` — user-initiated turn entered the pipeline.

## Payload shape

Hook bodies receive a single JSON object on stdin. Canonical keys:

```
{
  "schemaVersion": 1,
  "event": "<event-name>",
  "sessionId": "...",
  "turnId": "...",
  "attemptId": "...",
  "payload": { ... }  // event-specific fields
}
```

The `payload` subfield mirrors the `SessionEventPayloadMap` defined in
`src/protocol.ts` — inspect the compiled protocol schema for the
concrete fields per event.

## Exit-code semantics

A hook exits with:

- `0` — success. Bakudo continues.
- `1` — generic failure. Bakudo logs the stderr and continues (the hook
  is advisory, not authoritative).
- `2` — explicit deny. For approval hooks this is the auto-deny path.
- `3` — explicit allow. Approval hooks auto-approve.

Any non-zero exit code from a non-approval hook is treated as "log and
continue" so hook authors can surface warnings without blocking.

## Debugging tips

- Use `bakudo doctor` to verify the hook runtime surface (terminal
  capability, config cascade, renderer backend).
- Set `BAKUDO_HOOK_DEBUG=1` in your shell profile to echo every hook
  invocation to stderr.
- Hooks are discovered via the config cascade (`hooks.*` keys). The
  cascade resolution is visible via `/config show`.

## Out of scope

- Real OTel / OpenTelemetry wiring is deferred to Phase 6 W7; the stub
  exists today only in `bakudo doctor` output.
