# bakudo ↔ abox control-plane alignment

**Status:** proposed
**Date:** 2026-04-19
**Scope:** bakudo-side follow-up design after Phase 0 core integration landed
**Part of:** `2026-04-18-integration-roadmap.md` (addendum; does not renumber existing phases)
**Depends on:** abox worktree lifecycle already present; bakudo Phase 0 core integration already landed
**Blocks:** trustworthy live workflow hardening, preserved-worktree review, future multi-worker compare flows

---

## Goal

Realign `bakudo` with the model `abox` already implements:

- `abox` is the sandbox/worktree substrate.
- `bakudo` is the host control plane.

That means:

1. code-changing work must stop flowing through ephemeral sandboxes by default,
2. `assistant_job` must mean "run a real agent CLI in a sandbox", not "print prose",
3. host review must use worktree state, checks, and harvested artifacts rather than stdout alone,
4. merge/discard decisions must be host-owned and durable.

This note is intentionally bakudo-centric. It assumes `abox`'s existing worktree, merge, and cleanup behavior is correct and should be consumed rather than redesigned.

---

## Non-goals

Out of scope for this design:

- redesigning `abox` sandbox lifecycle or git-worktree behavior,
- broad CLI/TUI polish,
- replacing the current four intent kinds,
- a full provider-neutral agent abstraction before one verified backend exists,
- implementing full multi-worker compare/orchestration in the first correctness wave,
- rewriting the 2026-04-18 roadmap or renumbering its phases.

---

## Observations from HEAD

The following are the concrete mismatches this design is correcting.

### O-1. `assistant_job` is wired as output-only prose, not sandboxed agent work

`bakudo/src/worker/assistantJobRunner.ts` currently builds:

- `claude`
- optional `--dangerously-skip-permissions`
- `--print`
- prompt as a positional argument

That is not a reliable code-changing contract. It can report success without mutating the repo, which is exactly what the current live Python workflow test is already guarding against.

### O-2. bakudo defaults code-changing work to `--ephemeral`

`bakudo/src/aboxAdapter.ts` still resolves sandbox persistence via:

- `const ephemeral = process.env.BAKUDO_EPHEMERAL !== "0"`

and emits `abox run ... --ephemeral ...` by default.

That bypasses the preserved-worktree model `abox` already exposes via:

- `abox run` without `--ephemeral`
- `abox merge <task>`
- `abox stop <task> --clean`

### O-3. worker runtime ignores `TaskRunnerCommand.stdin`

`bakudo/src/worker/taskKinds.ts` supports a `stdin?: string` field, but `src/workerRuntime.ts` never writes it to the spawned process. That blocks clean noninteractive agent backends that want prompt input on stdin rather than argv.

### O-4. host review currently has no worktree-aware truth source

`src/reviewer.ts` can accept an attempt when:

- exit code is zero, and
- structured checks pass.

That is not sufficient for `implement_change`. A code-changing attempt can succeed with no actual mutation, or mutate the wrong files, and still look successful if the worker exited cleanly.

### O-5. the `run_check` path is structurally inconsistent

`compileAttemptSpec()` puts the derived check command in `spec.execution.command`, but `verification_check` execution in `src/worker/checkRunner.ts` only runs `acceptanceChecks[].command`.

So the current classification/compiler/runtime chain already has a check-specific mismatch that should be fixed while the dispatch model is being corrected.

### O-6. installed/release-bundle behavior still has correctness gaps

Current `bakudo` release/install shape still misses the default config file:

- `package.json` ships `dist`, `README.md`, `docs/help`, `scripts/install.sh`
- `scripts/package-release.sh` does not copy `config/`

That causes installed invocations to fail unless the caller manually points `--config` at a repo checkout.

### O-7. user-facing host wording still assumes "ephemeral code-changing sandbox"

Examples:

- `src/host/init.ts`
- `src/host/oneShotRun.ts`
- `src/host/sessionLifecycle.ts`
- `src/host/orchestrationSupport.ts`

Those strings describe the old model and will become misleading once code-changing work is preserved and host-reviewed.

---

## Principles

### P-1. Keep `abox` authoritative for sandbox lifecycle

`bakudo` should not invent a second merge/apply mechanism if `abox` already owns:

- branch/worktree creation,
- merge,
- stop/cleanup,
- ephemeral vs preserved behavior.

The host can inspect git state and worktree paths, but lifecycle actions should still call `abox` primitives.

### P-2. Keep worker-facing and host-facing concerns separate

`AttemptSpec` remains the worker-facing contract.

Sandbox persistence, post-run merge policy, artifact harvesting, and candidate comparison are host-owned concerns. They should not be smuggled into `assistant_job` semantics or inferred from stdout.

### P-3. stdout is evidence, not authority

For code-changing work:

- stdout can explain what happened,
- stdout can help debugging,
- stdout cannot be the sole proof that a requested change landed.

The authority is the preserved worktree plus host-side verification.

### P-4. failed or uncertain code-changing work should stay inspectable

If a code-changing attempt fails review, bakudo should prefer:

- preserve the candidate worktree,
- record where it lives,
- let the host choose merge, discard, or retry.

Blind discard destroys the most useful debugging evidence.

### P-5. single-worker correctness comes before multi-worker orchestration

The future "five approaches in parallel" design is valuable, but it must be built on a correct single-candidate lifecycle:

- preserved candidate,
- inspectable worktree,
- deterministic merge/discard,
- durable review record.

---

## Proposed model

### 1. Keep the existing intent kinds and task kinds

No new top-level intent taxonomy is needed right now.

Existing intent kinds stay:

- `inspect_repository`
- `implement_change`
- `run_check`
- `run_explicit_command`

Existing task kinds stay:

- `assistant_job`
- `verification_check`
- `explicit_command`

The correction is in host-owned dispatch policy, not in renaming everything.

---

### 2. Introduce a host-owned `DispatchPlan`

`planAttempt()` should stop returning only `{ intent, spec }`.

It should return a host-owned `DispatchPlan` that wraps the existing `AttemptSpec` and adds the control-plane decisions bakudo must own.

Suggested shape:

```ts
type DispatchPlan = {
  planVersion: 1;
  intent: TurnIntent;
  attemptSpec: AttemptSpec;
  executionProfile: ExecutionProfile;
  sandbox: {
    sandboxId: string;
    branchName: string;
    persistence: "ephemeral" | "preserved";
    guestCwd: "/workspace";
    outputDir: string;
  };
  reviewPolicy: {
    expectedOutcome: "report_only" | "worktree_change" | "mixed";
    postRunDisposition:
      | "discard"
      | "harvest_and_discard"
      | "merge_or_discard"
      | "compare_candidate";
    requireWorktreeChange: boolean;
    autoMergeOnAccept: boolean;
  };
};
```

Key decision:

- `AttemptSpec` remains worker-facing.
- `DispatchPlan` becomes the host planning/execution unit.

This keeps lifecycle policy out of the worker schema while making it durable and inspectable on the host.

---

### 3. Map intents to explicit execution profiles

The important correction is not "all `assistant_job`s are the same". The correction is "the host must declare what kind of sandbox result it expects".

Recommended initial mapping:

| Intent kind | Task kind | Sandbox persistence | Expected outcome | Post-run disposition |
| --- | --- | --- | --- | --- |
| `inspect_repository` | `assistant_job` | `preserved` | `report_only` | `harvest_and_discard` |
| `implement_change` | `assistant_job` | `preserved` | `worktree_change` | `merge_or_discard` |
| `run_check` | `verification_check` | `ephemeral` | `report_only` | `discard` |
| `run_explicit_command` | `explicit_command` | `ephemeral` in v1 | `report_only` or `mixed` | `discard` in v1 |

Notes:

- `inspect_repository` is preserved, not ephemeral, so the host can harvest durable report files from the worktree before cleanup.
- `implement_change` is preserved so the host can review the actual candidate diff before merging or discarding.
- `run_check` stays cheap and ephemeral.
- `run_explicit_command` remains conservative in the first wave. An explicit mutating-shell preserve mode can be added later once there is a clear UX/contract for it.

---

### 4. Redefine `assistant_job`

`assistant_job` should mean:

- run a noninteractive agent CLI inside the sandbox,
- against `/workspace`,
- with a host-declared result profile.

It should not mean:

- "ask an LLM for text",
- "print one message to stdout",
- "implicitly modify code",
- "implicitly discard or preserve its worktree".

### Initial backend recommendation

Use a verified code-changing backend by default.

Current evidence from the live guest suggests:

- `codex exec --full-auto` is a validated noninteractive editing path,
- `claude --print` is not.

So the first implementation should default `assistant_job` to a command profile based on `codex exec`, while leaving room for a future configured backend surface.

### Runner contract

`assistant_job` execution should be driven by `AttemptSpec.execution.command`, not a hardcoded CLI.

That lets the compiler/planner own backend selection and keeps the runner thin.

### Prompt delivery

worker runtime must honor `TaskRunnerCommand.stdin`. The runner should be able to:

- pass a bounded prompt on stdin when the backend prefers it,
- avoid oversized argv payloads,
- keep shell quoting simpler.

---

### 5. Reserve a guest output directory

Each attempt should have a deterministic guest-visible output directory:

```text
/workspace/.bakudo/out/<attemptId>/
```

Use it for agent-authored report artifacts such as:

- `summary.md`
- `notes.md`
- `references.json`

Rules:

- `inspect_repository` may write report artifacts there, but must not change normal repo files.
- `implement_change` may optionally write summary artifacts there, but code changes are represented by the worktree diff, not by an agent-authored patch.
- `run_check` and `run_explicit_command` do not rely on this directory in the first wave.

---

### 6. Prefer host-generated code-change artifacts

For `implement_change`, bakudo should stop relying on the agent to tell the truth about the patch.

Host-generated artifacts should become the durable source of record:

- `patch.diff` from the preserved candidate worktree,
- `changed-files.json` from host git inspection,
- `merge-result.json` after merge/discard,
- `result.json` summarizing the execution and review outcome.

Agent-authored `summary.md` can stay useful, but it is secondary evidence.

This change directly addresses the current "success with no mutation" class of bug.

---

### 7. Add host-side sandbox discovery and lifecycle records

After any preserved run, bakudo should resolve and persist:

- sandbox ID,
- branch name (`agent/<sandboxId>`),
- worktree path,
- lifecycle status (`active`, `merged`, `discarded`, `harvested`, `merge_failed`),
- merge/discard timestamps,
- cleanup result.

Recommended discovery strategy:

- derive branch name from sandbox/task ID,
- use `git worktree list --porcelain` on the host repo,
- match the worktree whose branch is `refs/heads/agent/<sandboxId>`.

This keeps bakudo aligned with abox's git-backed model without requiring new abox behavior.

Lifecycle actions should call:

- `abox merge <task>` for merge,
- `abox stop <task> --clean` for discard/cleanup.

---

### 8. Review against worktree state, not only worker exit state

Introduce a post-run inspection step before final review.

Suggested inspection outputs:

```ts
type WorktreeInspection = {
  sandboxId: string;
  branchName: string;
  worktreePath: string;
  changedFiles: string[];
  diffBytes: number;
  dirty: boolean;
  outputArtifacts: string[];
};
```

Review rules should then become profile-aware:

### `implement_change`

Accept only if all are true:

- worker execution succeeded,
- requested verification checks passed,
- host found a non-empty candidate diff or an explicitly-accepted no-op,
- merge succeeded when auto-merge is enabled.

Reject or retry when:

- the run exited 0 but no requested mutation landed,
- only `.bakudo/out/<attemptId>/` changed and no requested repo change landed,
- merge fails,
- verification checks fail,
- changed files obviously violate the request scope.

### `inspect_repository`

Accept only if:

- summary/report artifacts were harvested,
- no normal repo files changed outside the reserved output path.

If repo files changed, mark it as a behavioral failure even if the worker exited 0.

### `run_check`

Accept only if:

- the requested command actually ran,
- its result was captured correctly,
- no unexpected dirty worktree state remains.

### `run_explicit_command`

Keep semantics narrow in v1:

- run exactly what the user asked,
- capture output,
- treat any repo mutation as a surfaced fact, not a silently-merged result.

---

### 9. Merge and cleanup policy

### Successful `implement_change`

In auto/noninteractive mode:

1. preserve the sandbox,
2. inspect the candidate,
3. run host verification,
4. merge via `abox merge <task>`,
5. clean via `abox stop <task> --clean`,
6. persist merge and cleanup records.

This preserves the current expectation that a successful `bakudo build ... --yes` leaves the host repo updated.

### Failed or uncertain `implement_change`

Do not auto-discard.

Instead:

- persist the candidate metadata,
- leave the worktree available for inspection,
- return a result that clearly says the candidate is preserved pending host decision,
- allow follow-up `merge`, `discard`, or `retry from fresh base`.

Retries should start from a fresh candidate worktree, not mutate the failed candidate in place.

### Successful `inspect_repository`

1. harvest artifacts from `.bakudo/out/<attemptId>/`,
2. persist them into session artifacts,
3. discard the sandbox/worktree.

### Failed `inspect_repository`

If the failure is interesting and the worktree contains report artifacts, bakudo may still harvest them before discard, but repo mutation remains a failure.

---

### 10. Approval behavior

Approval should remain host-owned and deny-preserving, but prompt text must reflect the new lifecycle.

Examples:

- not "Dispatch into an ephemeral abox sandbox..."
- instead "Dispatch a preserved merge-candidate sandbox..."
- or "Dispatch a preserved report-only sandbox..."

Initial merge policy recommendation:

- auto/noninteractive mode: auto-merge on accepted `implement_change`,
- interactive standard mode: preserve the accepted candidate and let the host choose a follow-up merge/discard action in a later step.

This keeps the first correctness wave focused on auto-mode while leaving room for richer interactive merge review later.

---

### 11. Future parallel-worker model

Do not implement this in the first correctness wave, but make the data model compatible with it.

Host-level future wrapper:

```ts
type DispatchBatch = {
  batchId: string;
  strategy: "single" | "parallel_compare";
  candidates: DispatchPlan[];
  winnerPolicy: "manual" | "best_checks_then_manual";
};
```

The important part is that each candidate is just another preserved `DispatchPlan`.

That means future parallelism can be built on the same primitives:

- preserved candidate worktree,
- host inspection,
- merge one,
- discard the rest.

---

### 12. Test strategy

This design should be validated primarily through repeatable live workflows, not prose-only confidence.

### Reusable harness

Add a reusable live workflow harness that can:

- create isolated git repos,
- seed files,
- run bakudo with explicit repo/config/abox settings,
- inspect session artifacts and preserved worktrees,
- assert repo mutations and cleanup behavior,
- run in gated live mode via env vars.

### Minimum scenario set

The first implementation wave should automate at least these cases:

1. fresh Python repo: create file, edit README, run tests, merge success
2. fresh Node repo: create/edit files, run tests, merge success
3. inspect-only repo analysis: report artifact harvested, no repo mutation
4. `run_check`: command executes, output captured, no worktree preserved
5. `run_explicit_command`: explicit shell path executes, mutation surfaced but not silently merged
6. missing tool/runtime in guest: clear surfaced failure
7. approval-required vs auto-approved preserved change flow
8. JSON output mode for preserved merge/discard lifecycle
9. installed `abox` path and explicit `--abox-bin` path
10. preserved-failure cleanup: failed candidate remains inspectable, later discard works

### Contracts to assert

The tests should assert behavior, not noise:

- repo changed when success requires it,
- repo did not change when it must not,
- merge/discard state is durable,
- worktree path is correct,
- host/guest cwd assumptions are correct,
- failure is explicit when intended mutations are missing,
- cleanup removes preserved candidates only when asked.

---

## Open questions

These are the main review questions still worth confirming before implementation.

### Q-1. Should `inspect_repository` always preserve, or only when report artifacts are requested?

Recommendation:

- preserve in the first wave,
- harvest artifacts,
- discard immediately afterward.

That gives the cleanest durable report path and avoids inventing a stdout-only artifact protocol.

### Q-2. Which noninteractive agent CLI should be the default `assistant_job` backend?

Recommendation:

- default to the currently-verified `codex exec --full-auto` path,
- make the backend configurable later,
- do not keep `claude --print` as the default for code-changing work.

### Q-3. Should successful interactive standard-mode `implement_change` auto-merge?

Recommendation:

- no in the first interactive wave,
- yes in auto/noninteractive mode,
- preserve accepted candidates for later merge/discard in interactive mode.

### Q-4. Should mutating `run_explicit_command` preserve worktrees in v1?

Recommendation:

- no,
- keep explicit command semantics narrow first,
- add an explicit preserved-shell mode later if needed.

### Q-5. Should sandbox lifecycle facts live only on `SessionAttemptRecord`, or also in a dedicated append-only record?

Recommendation:

- start with a first-class snapshot on `SessionAttemptRecord`,
- emit event-log entries for lifecycle transitions,
- add a dedicated append-only lifecycle record only if inspect/reporting becomes awkward.

---

## Summary

The smallest correct correction is:

1. keep `abox` as the worktree substrate,
2. add a host-owned `DispatchPlan`,
3. make `assistant_job` a real agent CLI run,
4. preserve code-changing candidates,
5. review them against actual worktree state,
6. merge or discard via `abox`,
7. build the live workflow harness around that behavior.

That gives bakudo the control-plane role the current architecture already points toward, without asking abox to change its core model.
