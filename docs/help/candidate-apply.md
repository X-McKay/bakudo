# bakudo candidate apply

When a preserved code-changing attempt finishes, bakudo treats the preserved
sandbox worktree as a reviewed candidate. `accept` means "apply that
candidate into the current source checkout." It does not merge a sandbox
branch.

## Candidate lifecycle

- `candidate_ready` means the preserved candidate is ready for host apply.
- `apply_staging`, `apply_verifying`, and `apply_writeback` are durable host
  checkpoints.
- `needs_confirmation` means bakudo preserved the candidate because drift,
  overlap, or verification requires an explicit user decision.
- `applied`, `apply_failed`, and `discarded` are terminal candidate states.

Use `bakudo review` and `bakudo sandbox` to inspect the authoritative
candidate/apply state. Those views surface the source baseline, drift
decision, confirmation reason, apply dispatches, and resolution rationale.

## Drift gate

Bakudo records a source baseline when the preserved candidate is created, then
checks the current checkout again at apply time.

- Dirty and untracked source state is allowed.
- HEAD advancement is allowed only when the branch name still matches and the
  recorded baseline is an ancestor of the current `HEAD`.
- Repo mismatch, detached HEAD, branch switches, unrelated history, or a
  non-ancestor baseline block apply before the source checkout is mutated.

## Apply-time execution substrate

Bakudo owns candidate inspection and reconciliation, but it still runs
verification and model-assisted resolution through abox-backed dispatches.

- `apply_verify` runs the staged verification commands inside an ephemeral
  abox sandbox rooted at the apply workspace.
- `apply_resolve` handles only low-risk textual overlaps. The candidate stays
  preserved unless the resolution is high-confidence and verification passes.
- If verification fails or confidence is too low, bakudo records
  `needs_confirmation` and keeps the preserved candidate for follow-up.

## Discard and cleanup

`halt` discards the preserved candidate and asks abox to clean the preserved
sandbox worktree.

This cutover treats older local session state as disposable development data.
If pre-cutover records or artifacts are in the way, remove
`<repo>/.bakudo/sessions/` and `<repo>/.bakudo/artifacts/` before rerunning.
