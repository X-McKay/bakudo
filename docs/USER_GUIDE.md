# User Guide

This guide explains how to use Bakudo as an operator.

It focuses on the interactive TUI because that is where Bakudo's durable
mission workflow is clearest. If you want the product rationale or the low-level
runtime architecture, see:

- [product-motive-and-operator-workflow.md](product-motive-and-operator-workflow.md)
- [current-architecture.md](current-architecture.md)

## What Bakudo Is

Bakudo is a host-side mission conductor for repo work.

In practice that means:

- you give Bakudo an objective
- Bakudo reasons wake by wake
- repo work runs inside `abox` sandboxes
- Bakudo keeps durable mission state and a mission plan
- Bakudo asks you for help only when it actually needs a decision, approval,
  or review

Bakudo is not meant to feel like a chat window that forgets everything after
each reply. It is meant to keep a long-running task legible.

## What You Should Expect

When Bakudo is working well, you should be able to tell:

- which mission is active
- whether it is currently working, sleeping, blocked, or done
- what it is waiting on
- what changed most recently
- whether it needs something from you right now
- what you can do next

If those answers are unclear, use `/status`, `/missions`, `/sandboxes`, or
steer the active mission with a short message.

## Starting Bakudo

From the repo you want to work in:

```bash
bakudo
```

Bakudo opens a TUI with a transcript view and an input composer.

## What You Will See

Bakudo's interface is intentionally compact. The important surfaces are:

### Transcript

The transcript is the main running history. It shows:

- host replies
- mission activity updates
- worker starts and finishes
- approval and question outcomes
- mission completion summaries

Treat it as your orientation log, not as a raw provider dump.

### Composer

The composer is where you type:

- freeform steering
- new objectives
- slash commands

If the input starts with `/`, Bakudo parses it as a command. Otherwise it
treats it as host input or mission steering.

### Top working strip and mission banner

When mission work is active, the top area summarizes real runtime state such as:

- current focused mission
- whether a wake is running
- whether workers are running or queued
- active wave counts
- pending approvals
- pending user questions
- latest issue
- latest change

You should not need to scan the entire screen to answer "is Bakudo working, or
waiting on me?"

### Shared popup surface

Bakudo uses one popup pattern for:

- slash-command completion
- host approval requests
- user questions

If a popup is on screen, Bakudo is waiting for explicit input. Do not expect a
stray `Enter` to accept an important decision by accident.

## The Normal Operator Loop

Most real use follows this shape:

1. start or focus a mission
2. let Bakudo deliberate and dispatch work
3. watch for real intervention points
4. review preserved changes if needed
5. steer or resume if the mission needs direction
6. finish when the mission summary matches your actual goal

Bakudo is built to keep working across multiple wakes and multiple worker waves.
You do not need to restate the whole problem every turn.

## Starting Work

You can start work in two main ways.

### Start a mission

Use mission posture when you want Bakudo to drive toward a concrete outcome:

```text
/mission fix the failing runtime tests
```

Mission posture is the normal choice for implementation, verification, and
closure-oriented work.

### Start an exploration

Use explore posture when the first job is understanding rather than landing a
fix:

```text
/explore understand why task summaries are weak
```

Explore posture is appropriate when the question is still open and the next
best step is investigation.

### Freeform objective input

You can also type a plain sentence instead of a slash command. The host layer
may start a mission directly, or it may ask one follow-up question if your goal
is too vague.

Example:

```text
Fix the CI failures
```

Bakudo may respond with a short clarification request such as asking what
"done" looks like. That is expected. Reply once with the acceptance criteria or
constraints you care about.

## When You Are Expected To Engage

Bakudo should work autonomously inside its defined boundaries. Your involvement
is most valuable at a small number of explicit points.

### 1. Clarifying the objective

You should engage when:

- the starting goal is vague
- the acceptance criteria matter
- the task has constraints Bakudo should not infer on its own

Good clarifications are concrete:

- "Done when `just check` passes and the fix is ready for review."
- "Do not auto-merge preserved worktrees."
- "Prefer the smallest durable change."

### 2. Steering the active mission

While a mission is active, plain text becomes steering.

Examples:

- "Focus on the daemon path, not the TUI."
- "Stop after the first reviewable candidate."
- "Do not touch provider defaults yet."

Use steering when priorities or scope change. You do not need to restart the
whole mission unless the objective itself has changed.

### 3. Host approval prompts

You are expected to engage when Bakudo requests a host approval.

This only happens when the mission runtime decides a command must run on the
host rather than inside `abox`.

The approval popup shows:

- the command
- the reason Bakudo is asking

Your choices are effectively:

- approve
- edit then approve
- deny

Approve only if the host action actually matches your intent. Deny if the
mission should find a different path or if the command crosses a boundary you
do not want crossed.

### 4. User question prompts

You are expected to engage when Bakudo asks a blocking question.

This usually means:

- the mission needs a product or policy choice
- multiple valid next steps exist
- further work would be wasted without your answer

Answer as directly as possible. Bakudo records the answer and resumes the wake.

### 5. Preserved worktree review

You are expected to engage when Bakudo leaves a preserved candidate for review.

This is the normal place to inspect code changes before merge.

Typical review flow:

1. `/sandboxes`
2. `/diff <task-id>`
3. optional: `/diverge <task-id>`
4. `/apply <task-id>` or `/discard <task-id>`

If you want Bakudo to continue after the review, steer the mission with a short
message or force a wake with `/wake`.

## What Bakudo Should Do Without You

Bakudo should handle these autonomously:

- reading the current mission plan
- keeping durable mission state current
- dispatching sandboxed workers
- verifying inside `abox` when possible
- waiting across wakes
- summarizing worker outcomes
- surfacing mission progress in the transcript and banner

If Bakudo asks you to do routine sandbox work manually, that is usually a sign
that the mission still needs steering or that a runtime boundary was reached.

## Slash Commands

These are the commands available in the TUI today.

## Mission Control

### `/mission <goal>`

Start a mission posture for a concrete objective.

Use this for:

- code changes
- bug fixing
- implementation work
- "take this to a real done state"

### `/explore <goal>`

Start an explore posture for investigation-first work.

Use this for:

- diagnosis
- architecture questions
- understanding before implementation

### `/missions`

List active and recent missions for the current repo.

Use this when:

- you resumed a session and want orientation
- more than one mission exists
- you want to see whether the previous mission is still active or completed

### `/focus <number-or-id-prefix>`

Focus a mission from the mission list.

Use this when:

- you want the current session to steer a different mission
- you resumed and the wrong mission is focused

### `/budget time=<minutes>m workers=<count>`

Adjust the active mission wallet.

Examples:

```text
/budget time=45m workers=8
/budget workers=4
```

Use this when:

- you want to limit concurrency
- you want to give a longer-running mission more room

### `/wake`

Force a manual wake for the active mission.

Use this when:

- you just answered a question outside the normal flow
- you want the conductor to reconsider the current state now
- the mission is sleeping and you want immediate re-evaluation

### `/lessons`

Show the repo lessons directory.

Use this when:

- you want to inspect durable lessons captured by the mission runtime

## Provider and Model Commands

### `/provider <id>`

Switch the active provider for classic runs.

Example:

```text
/provider claude
```

This is mainly relevant for classic one-shot work or provider debugging. A
running mission uses the provider stored with that mission.

### `/approve`

Approve the next classic task dispatch when execution policy requires a prompt.

This is a narrowly scoped command. It does not replace host approval popups for
mission-time `host_exec`.

### `/model [name]`

Set or clear the raw model override for the current provider.

Examples:

```text
/model claude-opus-4-5
/model
```

An empty `/model` clears the override and returns to the provider default.

This is an advanced control. It is usually not needed for normal mission work.

### `/providers`

List all registered providers.

Use this when:

- you need to confirm which provider ids are available

## Worktree Review Commands

### `/sandboxes`

List active and preserved sandboxes.

Aliases:

- `/ls`
- `/list`

This is the starting point for reviewing preserved worker output.

### `/diff <task-id>`

Show a colorized unified diff for a preserved worktree.

Use this to inspect exactly what changed before applying it.

### `/diverge <task-id>`

Show divergence relative to the base branch for a preserved worktree.

Use this to understand the branch-level relationship before merge.

### `/apply <task-id>`

Merge a preserved worktree into the base branch.

Use this only after reviewing the candidate.

### `/discard <task-id>`

Discard a preserved worktree.

Use this when:

- the candidate is wrong
- the candidate is outdated
- the mission should try a different path

## Session and Visibility Commands

### `/status`

Show session/provider/model/task counts.

Use this for a quick local summary when you want a compact answer.

### `/config`

Show the active runtime configuration.

Use this when:

- you need to confirm config layering or runtime paths

### `/doctor`

Probe `abox` and provider binaries for health issues.

Use this when:

- Bakudo behaves unexpectedly at startup
- provider commands are failing before real mission work begins

### `/clear`

Clear local history state while leaving terminal scrollback intact.

Use this when the transcript is cluttered but you do not want a new session.

### `/new`

Start a fresh transcript/session view without erasing terminal scrollback.

Use this when:

- you want a cleaner local interaction surface
- you do not want older session history in the current view

### `/help`

Show the command catalog.

### `/quit`

Exit Bakudo.

Aliases:

- `/exit`
- `/q`

## End-to-End Example

The example below shows a realistic mission flow.

Goal:

"Fix the failing runtime tests around worker hand-offs, verify the result, and
only merge reviewed changes."

### Step 1. Start Bakudo in the repo

```bash
cd /path/to/repo
bakudo
```

What you should expect to see:

- the transcript area
- the input composer
- no active mission yet, or a resumed mission if you returned to an existing
  session

### Step 2. Start the mission

Type:

```text
/mission fix the failing runtime tests around worker hand-offs
```

If your objective is still underspecified, Bakudo may ask one follow-up
question such as what "done" means. If that happens, reply once with the real
acceptance criteria:

```text
Done when just check passes, the worker summary path is covered by tests, and
reviewable changes are preserved instead of auto-merged.
```

What you should expect to see:

- a transcript message that the mission started
- the mission becomes the focused mission
- the top working strip or mission banner shifts into an active state

### Step 3. Let Bakudo orient and dispatch work

Bakudo will read the current plan, inspect mission state, and decide what to
run. It may dispatch one or more workers inside `abox`.

What you should expect to see:

- transcript entries for worker start and finish events
- the banner showing whether a wake is running
- worker counts and active-wave counts changing as work is dispatched and
  completed

What you are expected to do:

- usually nothing yet
- only intervene if the mission's direction is wrong

If you want to steer it, type a plain sentence:

```text
Keep the fix scoped to the daemon path. Do not change the TUI unless the test
requires it.
```

### Step 4. Respond if Bakudo needs the host

If the mission reaches a real host-boundary action, Bakudo may show an approval
popup.

What you should expect to see:

- a popup with the requested command
- a reason for the request

What you are expected to do:

- approve if the command matches your intent
- edit if the command is nearly right but needs correction
- deny if Bakudo should stay inside `abox` or take another path

If no approval popup appears, that is good. It means Bakudo stayed within the
normal sandbox boundary.

### Step 5. Answer a blocking product or policy question if asked

If Bakudo reaches a genuine fork in the road, it may show a user-question
popup.

Example:

- "Apply the first passing candidate now, or continue exploring alternatives?"

What you are expected to do:

- choose the option that best matches the actual product goal

What you should expect afterward:

- the answer is recorded
- the wake resumes
- the transcript reflects the decision

### Step 6. Review a preserved candidate

Suppose a worker finishes with a preserved worktree because the mission is at a
review boundary.

Use:

```text
/sandboxes
/diff bakudo-attempt-abc123
/diverge bakudo-attempt-abc123
```

What you should expect to see:

- the preserved candidate in the sandbox list
- a readable diff
- divergence information relative to the base branch

If the candidate is correct:

```text
/apply bakudo-attempt-abc123
```

If the candidate is wrong:

```text
/discard bakudo-attempt-abc123
```

After that, steer the mission if needed:

```text
Continue from the applied fix and run the full verification path.
```

### Step 7. Watch for completion

When the mission is done, Bakudo should record a completion summary.

What you should expect to see:

- a transcript completion message
- the mission no longer shown as working
- `/missions` showing the mission as completed

Use:

```text
/missions
```

to confirm the final state if needed.

## Troubleshooting Your Own Workflow

If Bakudo feels unclear, these commands are the quickest recovery tools:

- `/status`: compact local summary
- `/missions`: durable mission list
- `/focus <selector>`: move the session to the right mission
- `/sandboxes`: inspect preserved worktrees
- `/doctor`: verify runtime health
- `/wake`: force reconsideration if the mission should resume now

If the mission is moving in the wrong direction, plain-language steering is
usually better than restarting from scratch.

## Good Operator Habits

Bakudo works best when you:

- start with a clear objective
- give a real done contract when it matters
- let sandbox work run without constant interruption
- review preserved changes before applying them
- answer approvals and questions concretely
- use steering to adjust scope instead of re-explaining everything

## Short Version

If you only remember one workflow, remember this:

1. start with `/mission ...` or `/explore ...`
2. let Bakudo work inside `abox`
3. respond only to real approvals or questions
4. review preserved worktrees with `/sandboxes` and `/diff`
5. `/apply` or `/discard`
6. steer with short plain-language messages when priorities change

That is the normal operator loop.
