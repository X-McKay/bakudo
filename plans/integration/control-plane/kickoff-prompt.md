# Kickoff Prompt — bakudo Control-Plane Realignment

> **How to use this file.** Drop the contents below the `---` line into a new agent session as the first user message. The prompt is self-contained: it tells the agent which docs to read, in what order, and how to behave throughout the implementation. If you (the human) want to brief the agent verbally instead, the same content works as a checklist for what to convey.

---

You are an implementing engineer (or autonomous coding agent) tasked with executing a major control-plane realignment of the **bakudo** repository. A complete, junior-engineer-proof plan set has already been written for you. **Your job is to execute the plans faithfully, not to redesign anything.**

## 1. Identity, Repository, Branch

- Repository: `X-McKay/bakudo` (clone with `gh repo clone X-McKay/bakudo`).
- Working branch: **`manus/20260419`** (already exists; do **not** re-cut from `main`).
- Sister repository for context only (do not modify): `X-McKay/abox`, branch `release/v0.3.0-prep`.
- Local checkout convention: the parent workspace is `bakudo-abox/` containing `bakudo/` and `abox/` side-by-side. The golden test fixtures referenced by `bakudo/tests/helpers/golden.ts` live in `bakudo-abox/plans/bakudo-ux/examples/` (parent workspace), not inside `bakudo/`. If those fixtures aren't available, the corresponding golden tests will fail; treat that as an environmental issue, not a regression you caused.

## 2. Mandatory Reading (in order, before writing any code)

Read these documents end-to-end. Do not skim. Each one materially affects how subsequent work must be done.

1. `AGENTS.md` (root) — project conventions: TypeScript style, Zod schemas, functional state updates, no `any`, comprehensive tests, deterministic snapshots.
2. `plans/integration/2026-04-19-bakudo-abox-control-plane-spec.md` — the canonical architectural vision. The "why" behind every wave.
3. `plans/integration/2026-04-19-bakudo-abox-control-plane-implementation-plan.md` — the high-level wave breakdown.
4. `plans/integration/2026-04-19-control-plane-review.md` — the design-readiness review identifying the gaps you'll be closing.
5. `plans/integration/2026-04-19-implementation-progress.md` — what's already done. **You start at the next unchecked wave.**
6. `plans/integration/control-plane/README.md` — index of the detailed plan set + dependency graph.
7. `plans/integration/control-plane/00-execution-overview.md` — sequencing strategy, parallelism, hand-off criteria.

Then, immediately before starting a given wave, read its detail document under `plans/integration/control-plane/waves/`. Re-read it after every coding session — the file lists and code snippets are exhaustive and meant to be referenced repeatedly.

## 3. Pinned Decisions

These four questions were resolved before this prompt was written. Do **not** re-litigate them.

| # | Topic | Decision |
| :--- | :--- | :--- |
| Q1 | `inspect_repository` persistence | Preserved sandbox, harvest worktree, then discard. |
| Q2 | Default `assistant_job` backend | `codex exec --dangerously-bypass-approvals-and-sandbox` (the abox guest **is** the sandbox boundary; bypassing the codex sandbox is correct here). The backend is configurable; a `claude` profile may be added later but is not required. |
| Q3 | Interactive merge behavior | Auto-merge only in `auto`/`noninteractive` mode for v1. Interactive standard mode preserves accepted candidates pending follow-up. |
| Q4 | `run_explicit_command` mutation | Ephemeral in v1; surface mutation as a fact in the result rather than persisting state. |

## 4. Operating Constraints (non-negotiable)

These are user-set rules. Violating any of them is a defect.

- **Sequential waves only.** Implement Wave 1, commit it, verify, then Wave 2, etc. Do not interleave waves. The dependency graph in `control-plane/README.md` shows why: W3 and W4 are the critical path and depend on W1's data model.
- **Strict adherence to the wave plans.** Each `waves/*.md` document specifies the exact files to add, modify, and delete, with code snippets and rationale. Follow them. If you find a deviation is necessary, write a short ADR under `plans/integration/adr/` and proceed only after the deviation is documented.
- **No legacy preservation.** When a wave tells you to delete `WorkerTaskSpec`, `executeTask`, `BAKUDO_EPHEMERAL`, the `claude --print` runner, the prose-only `assistant_job` runner, or the `request/result/metadata` legacy attempt fields — **delete them entirely**. Do not comment them out, mark them `@deprecated`, or wrap them behind a feature flag. The directive is "clean codebase, no backward compatibility."
- **Functional state updates.** Per `AGENTS.md`, mutation of session state, attempt records, planner state, etc. must be done by returning new objects, not by in-place edits.
- **Tests are part of "done".** A wave is not done until `pnpm build` succeeds, `pnpm test:unit` is green, the new tests prescribed by the wave plan are written, and (where applicable) golden snapshots are updated via `UPDATE_GOLDENS=1 pnpm test`. Inspect the golden diff before committing — never blind-accept.
- **Frequent commits, push every commit.** One commit per logical slice; multiple commits per wave is fine. Push to `origin/manus/20260419` after each commit. Use Conventional Commits prefixes (`feat`, `fix`, `refactor`, `test`, `docs`, `chore`).
- **Update the progress tracker.** After each wave is committed, append a short entry to `plans/integration/2026-04-19-implementation-progress.md` under "Per-wave notes": what landed, what tests cover it, anything notable. Then check the wave off in the checklist.

## 5. Sequencing Rules

| Wave | Plan document | Status entering this work |
| :--- | :--- | :--- |
| W0.1 | `waves/01-wave-0-correctness.md` (§ Configuration) | **Already landed** in commit `c699ad9`. Do not redo. |
| W0.2 | `waves/01-wave-0-correctness.md` (§ Stdin pipeline) | Pending. **Start here.** |
| W0.3 | `waves/01-wave-0-correctness.md` (§ run_check fix) | Pending. |
| W0.4 | `waves/01-wave-0-correctness.md` (§ Lifecycle wording) | Pending. |
| W1 | `waves/02-wave-1-data-model.md` | Pending. Foundation for everything else. |
| W2 | `waves/03-wave-2-worker-backend.md` | Pending. May parallelize with W3 *only after* W1 lands. |
| W3 | `waves/04-wave-3-orchestration.md` | Pending. Critical-path; biggest deletion of legacy code. |
| W4 | `waves/05-wave-4-review-decoupling.md` | Pending. Depends on W3. |
| W5 | `waves/06-wave-5-persistence-ui.md` | Pending. Depends on W4. |
| W6/W7 | `waves/07-waves-6-7-harness-batch.md` | Pending. Depends on W5. |
| UX | `waves/08-ux-realignment.md` | Pending. Depends on W5. May run in parallel with W6/W7. |

## 6. Quality Gates per Wave

Before committing the final commit of a wave, run this checklist (and write the results into the progress note):

1. `pnpm build` — clean, no TypeScript errors.
2. `pnpm test:unit` — all green.
3. New unit tests prescribed by the wave plan — present and passing.
4. Golden snapshots — regenerated if the wave touches rendering, and the diff has been **manually inspected** for sanity.
5. Files marked "delete" in the wave plan — actually deleted (`git status` should show them as deletions).
6. Progress tracker — appended to and the wave checkbox flipped.
7. ADRs — written for any deviation from the plan.

If any of these is red, the wave is not done. Fix and re-verify before moving to the next wave.

## 7. When the Plan and Reality Disagree

The plan documents are accurate as of the date they were written, but code drifts. If you find that:

- A file the plan says to modify has been renamed or removed → **stop**, ask the user, and write an ADR before deciding.
- The plan's code snippet doesn't compile against the current types → **stop**, re-read the relevant pre-read sections of the spec, and adapt minimally. Document the adaptation in an ADR.
- A test the plan asks you to write conflicts with an existing test → **stop**, do not silently delete the existing test. Resolve the conflict explicitly and document it.
- The acceptance criteria can't be met → **stop**. Do not paper over with a weakened test or a `// TODO`.

The user has explicitly asked: "no placeholders or items left for later extension or work." Honor that.

## 8. Communication Protocol

- After each wave is committed and pushed, post a short status: `Wave N landed: <commit-sha> — <one-line summary>. Tests: <pass/fail counts>. Next: Wave N+1.`
- After every two waves (or any unexpected blocker), pause and ask whether to keep going.
- Do not narrate every tool call. Status updates at wave boundaries are the right granularity.

## 9. First Action

Right now, do this:

1. Confirm you can run `git status` inside `bakudo/` and that you're on `manus/20260419`. If not, switch.
2. Read the documents listed in §2 in order.
3. Read `plans/integration/control-plane/waves/01-wave-0-correctness.md` and execute the **W0.2 (stdin pipeline)** section. W0.1 is already done — start with stdin. Then W0.3, then W0.4. Commit each as a separate slice. Push after each.
4. Once W0 is fully checked off in the progress tracker, ask the user before proceeding to Wave 1.

Begin.
