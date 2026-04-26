# Product Motive and Operator Workflow

This document explains why Bakudo exists, what operator workflow it is trying
to support, and which product constraints shape the current runtime.

Read this together with [current-architecture.md](current-architecture.md):

- this document explains the product motive, operator model, and user-facing
  semantics
- `current-architecture.md` explains the concrete runtime, storage, and code
  structure that implement those semantics

## Executive Summary

Bakudo exists because repo work that matters rarely fits the "one prompt, one
provider invocation, one answer" model.

Real software work often looks like this instead:

1. a human defines a goal
2. the system needs to investigate, plan, and split work
3. some steps should happen inside isolated sandboxes
4. some steps need host approval or user clarification
5. work may span multiple waves, restarts, and review points
6. the operator needs to stay oriented the entire time

Bakudo is the conductor for that workflow.

It is not primarily trying to be:

- a generic terminal chatbot
- a hidden background agent that mutates the host directly
- a decorative dashboard that guesses at state
- a fake abstraction layer that pretends all providers expose the same model
  and tool semantics

Its core job is to keep long-lived repo work legible, reviewable, and safe
enough to trust.

## Why Bakudo Exists

### The problem with one-shot agent execution

One-shot execution is useful, but it has hard limits:

- the provider call forgets its state as soon as the process exits
- the human has to reconstruct intent and progress from scrollback
- there is no durable "what are we waiting on?" state
- multiple parallel workers become difficult to track coherently
- repo mutations can blur together with host state and credentials

Bakudo keeps classic one-shot execution because it is still a good tool for
small isolated tasks. It adds a second runtime because that model is not enough
for durable mission work.

### The problem with direct host autonomy

Letting an agent act directly on the host collapses too many responsibilities:

- execution
- repo mutation
- worktree ownership
- approval boundaries
- credential exposure
- post-run review

Bakudo keeps those concerns separated on purpose:

- `abox` is the execution boundary
- Bakudo owns worktree lifecycle on the host
- the operator remains the final authority on preserved candidate application
- mission state is durable and inspectable

### The problem with product ambiguity

Many agent products fail because they never decide what they are optimizing for.
They blend:

- chat
- background jobs
- dashboards
- task runners
- autonomous coding

without a clear mental model.

Bakudo chooses a narrower model:

- the user operates a mission
- the mission is the durable unit of work
- wakes are the reasoning boundary
- experiments are the execution boundary
- worktrees are the review boundary

That is the conceptual center of the product.

## Product Thesis

Bakudo is a host-side mission conductor.

That sentence has concrete implications:

### Host-side

Bakudo is responsible for:

- deciding when to start or resume work
- tracking durable mission state
- presenting truthful operator status
- owning preserved worktree apply/discard decisions
- mediating host approvals and user questions

It does not delegate those product responsibilities to the provider.

### Mission

The top-level object is not "the latest prompt". It is a durable objective with
state:

- goal
- posture
- wallet
- mission plan
- mission state
- wake history
- experiment history
- pending approvals
- pending user questions

The user should be able to leave and return later without the product losing
the thread.

### Conductor

Bakudo does not assume one provider process should do everything itself.
Instead, the conductor can:

- reason at wake boundaries
- dispatch sandboxed workers
- wait for concrete outcomes
- merge what changed into durable mission state
- ask the user for a decision only when necessary

This is why the runtime distinguishes deliberator wakes from worker
experiments.

## Target User

Bakudo is aimed at a technical operator who:

- owns or understands the repo they are working in
- wants agent help on non-trivial multi-step work
- values reviewable changes over raw speed theater
- is comfortable steering work with short natural-language messages or slash
  commands
- expects the system to preserve orientation across time

The target user is not asking for an omniscient autonomous IDE. They want a
system that can hold onto the problem, drive work forward, and expose the real
state without forcing constant babysitting.

## The Operator Questions Bakudo Must Answer

At any moment, the operator should be able to answer:

1. what mission is active
2. whether it is working, blocked, sleeping, or done
3. what the system is waiting on
4. what changed most recently
5. whether Bakudo needs something from the user right now
6. what action the user can take next

These are not aesthetic goals. They are the core usability contract.

If the UI does not answer them from real runtime signals, Bakudo is not done.

## Operator Mental Model

The product is easiest to use when the operator carries the right model:

### Session

A session is the local interactive shell or daemon context. It owns:

- current provider/model selection for classic runs
- the transcript
- the session-scoped host runtime
- the focused mission

Sessions are resumable, but they are not the durable unit of mission work.

### Mission

A mission is a durable objective with posture, wallet, mission plan, mission
state, wake history, and experiment history.

There may be multiple missions for a repo over time. One of them may be
focused in the current session.

### Wake

A wake is a single deliberation turn for the mission conductor. A wake begins
with a `WakeEvent` and ends with exactly one of:

- `complete_mission(...)`
- `suspend(...)`

The wake is the main reasoning boundary. It is where the conductor reads the
current plan, inspects mission state, looks at what is in flight, and decides
what to do next.

### Experiment

An experiment is a sandboxed worker run launched through `dispatch_swarm`.
Experiments are the unit of actual execution inside `abox`.

Experiments may be:

- script workers
- provider-backed agent workers

They are durable enough to survive restarts because their metadata and
summaries are persisted by `MissionStore`.

### Candidate

A candidate is a preserved worktree outcome. It exists because execution inside
`abox` is intentionally separated from host-side merge/discard decisions.

### Mission Plan vs Mission State

Bakudo intentionally keeps two durable mission artifacts:

- `mission_plan.md`: concise human-readable orientation
- `MissionState`: compact machine-readable working memory

This split matters.

The plan is for the operator and future humans reading the mission. The mission
state is for the conductor to resume accurately without reparsing prose.

## Target Workflow

### 1. Start or focus a mission

The operator begins with a goal through:

- freeform chat routed through the host layer
- `/mission <goal>`
- `/explore <goal>`
- `/missions`
- `/focus <selector>`

The host layer is intentionally thin. It does not try to be a full agent. It
only does enough to:

- answer obvious status questions locally
- ask for a clearer done contract when needed
- start a mission immediately when the objective is already clear
- route follow-up steering into the active mission

### 2. Establish durable intent

When a mission starts, Bakudo persists:

- the mission row itself
- the initial `MissionState`
- an initial `mission_plan.md`
- a manual resume wake

This is the first important product move: Bakudo does not treat the initial
goal as ephemeral chat text. It turns it into durable mission context.

### 3. Deliberate at a wake boundary

When a wake runs, the deliberator receives:

- the system prompt for the posture
- the current `WakeEvent`
- the durable `MissionState`
- the current mission plan
- the mission-native MCP tool surface

The conductor should:

- orient
- repair stale state if needed
- decide whether to inspect, dispatch, ask, notify, or complete
- leave the mission in a clean hand-off state before suspending

### 4. Dispatch real work inside `abox`

If the mission needs repo work, Bakudo launches experiments through
`dispatch_swarm`.

This is where the product's execution model becomes concrete:

- repo work happens in `abox`
- each experiment has an explicit workload and host-side worktree policy
- active wave state is persisted
- concurrency is bounded by the mission wallet and wave configuration

The user is not meant to think in terms of ad hoc subprocesses. They are meant
to think in terms of durable wave execution.

### 5. Observe what is happening

While work is in flight, the operator should be able to see:

- which mission is focused
- whether the wake is running or idle
- how many workers are running or queued
- whether a wave is active
- whether approval or user input is pending
- the latest issue and latest change

This is why the TUI emphasizes mission banner state, inline activity, and
scrollback-oriented transcript updates instead of generic dashboard chrome.

### 6. Intervene only when the runtime actually needs help

Bakudo has two explicit operator-intervention surfaces:

- `host_exec` approval
- `ask_user` questions

These are product-critical because they are truthful. If Bakudo needs a host
action or a blocking decision, it can say so explicitly.

Bakudo should not invent fake "working" semantics when it is really waiting for
an approval or a user answer.

### 7. Review preserved candidates

If an experiment ends with a preserved worktree, the operator can:

- inspect divergence
- inspect diff
- apply
- discard

This is where Bakudo's "trust over vibes" stance shows up. The worker may have
done good work, but Bakudo still keeps host-side merge control outside the
sandbox.

### 8. Resume, recover, or complete

Missions are expected to survive:

- multiple waves
- user steering
- approval round trips
- daemon or TUI restarts

When the goal is satisfied, Bakudo records a completion summary and marks the
mission terminal. Until then, it keeps enough durable state for later wakes or
later sessions to continue without guesswork.

## What Good Operation Feels Like

The intended operator experience is:

- calm, because the screen shows the small set of states that matter
- legible, because those states map to real runtime objects
- trustworthy, because Bakudo does not pretend to know things it does not know
- resumable, because mission state and plan are durable
- reviewable, because repo changes remain bounded by worktree policy

Bakudo should feel more like a conductor's console than a chat transcript with
tool spam.

## Runtime-to-Product State Mapping

Bakudo only wants to present user-facing status that maps to real runtime
signals.

### Active mission

An active mission is the mission focused by the current session host runtime.
That focus is reconciled with durable mission state so the session does not
drift away from the real active mission.

### Working

Bakudo can truthfully say a mission is working when at least one of these is
true:

- the current wake is running
- one or more experiments are running
- an active wave still has queued work to schedule

### Sleeping

A mission is sleeping when it is not currently deliberating and is waiting for
an external trigger such as:

- worker completion
- manual wake
- scheduler tick
- a user message

Sleeping is not failure. It is a real and useful mission state.

### Blocked

Bakudo should only imply blocked semantics when it has a concrete reason, such
as:

- a pending host approval
- a pending user question
- a surfaced tool-call issue
- a worker failure that now requires follow-up

It should not synthesize a generic blocker from silence alone.

### Done

Done maps to terminal mission status, not to a visual impression that nothing
else is moving.

## Why the Architecture Looks This Way

Several architectural decisions come directly from the product motive.

### `MissionStore` is the durable authority

Because the mission is the product, durable mission state cannot live only in
provider context or transient TUI state.

### TUI and daemon use typed channels

Because operator visibility is part of the product, the UI must consume typed
runtime events instead of scraping text or spawning work directly.

### `abox` remains the execution boundary

Because host trust matters, repo execution happens in sandboxes and Bakudo owns
the boundary crossing.

### Worktree lifecycle is host-owned

Because reviewability matters, sandbox workers do not merge their own changes.

### Mission and classic execution stay separate

Because one-shot tasks and durable missions are different products with
different semantics, Bakudo keeps distinct execution paths instead of forcing
them through a misleading common layer.

### Model identity stays truthful

Because trust matters, Bakudo does not pretend it has a provider-model picker
when it does not yet have truthful runtime model inventory.

### Worker hand-offs are explicit

Because multi-wave work depends on resumability, Bakudo now asks provider-backed
workers to emit a concise `BAKUDO_SUMMARY:` hand-off and persists that summary
with the experiment result.

## Non-Goals

Bakudo is intentionally not trying to be:

- a generalized host shell automation framework
- a self-merging background codebot
- a provider-agnostic model marketplace UI
- a replacement for understanding the repo
- a system that hides missing runtime signals behind polish

These non-goals help keep the design coherent.

## Practical Reading Order

If you are new to the repo and want to understand Bakudo end to end:

1. read this document for product motive and target workflow
2. read [current-architecture.md](current-architecture.md) for the shipped
   runtime model
3. read `AGENTS.md` for development invariants
4. inspect `crates/bakudo-daemon/src/session_controller.rs` and
   `crates/bakudo-daemon/src/mission_store.rs` for the concrete control flow

## Summary

Bakudo exists to make long-lived agent work operable.

The runtime, UI, worktree policy, and mission storage model all follow from the
same decision: mission state is the product, and the operator must be able to
trust what the product says about it.
