# Mission Management Options

**Date:** 2026-04-26
**Status:** design note for the next Bakudo TUI slice

## Current facts

- `MissionStore` can persist many missions for a repo.
- The session runtime still has a single `active_mission_id`.
- The TUI has no way to list missions or switch focus.
- Startup recovery already loads multiple active missions, but host-side focus
  is effectively implicit and fragile.

That means Bakudo already has multi-mission data, but not a coherent
multi-mission operating model.

## Option 1 — Strict one-at-a-time mission mode

**Workflow optimized for:** a single operator running one mission to
completion before starting another.

**What becomes clearer:** the focused mission is always the only active
mission.

**What becomes more cumbersome:** background work and restart recovery become
awkward, because the store can already contain multiple active missions.

**Implementation complexity:** low.

**Architectural fit:** mediocre. It fights the current store/runtime shape.

**Risk of future UI debt:** medium. If Bakudo later needs even light-weight
parallel mission management, this option becomes a dead end.

**Likely follow-on work:** stronger guards that reject starting a second active
mission and more explicit completion/cancel flows.

## Option 2 — Single focus, multiple stored missions

**Workflow optimized for:** one mission in the foreground, with the ability to
switch to another active mission when needed.

**What becomes clearer:** there is one explicit focused mission, and the
operator can ask “what is active right now?” without losing access to other
missions.

**What becomes more cumbersome:** switching context is a deliberate action
instead of being inferred automatically.

**Implementation complexity:** moderate.

**Architectural fit:** strong. It matches the existing `active_mission_id`
session model while respecting that `MissionStore` can contain many missions.

**Risk of future UI debt:** low. The model scales into richer mission lists or
pickers later without forcing a dashboard today.

**Likely follow-on work:** a popup mission picker, recent-mission summaries,
and clearer resume semantics for completed missions.

## Option 3 — Always-visible mission inbox rail

**Workflow optimized for:** operators supervising several missions at once.

**What becomes clearer:** global mission awareness is always on screen.

**What becomes more cumbersome:** the TUI starts to behave like a dashboard,
and every focused task competes with persistent management chrome.

**Implementation complexity:** high.

**Architectural fit:** acceptable, but premature.

**Risk of future UI debt:** high. This pushes Bakudo toward a control panel
before the interaction model is settled.

**Likely follow-on work:** persistent selection state, wider layout changes,
and a larger redesign of the shelf/footer/top strip balance.

## Option 4 — Conversational mission targeting only

**Workflow optimized for:** minimum visible controls.

**What becomes clearer:** very little on screen changes.

**What becomes more cumbersome:** mission routing becomes implicit, which is
exactly where operator trust erodes.

**Implementation complexity:** moderate.

**Architectural fit:** weak. It depends on heuristics instead of explicit
session state.

**Risk of future UI debt:** high. Hidden routing rules become hard to explain
and harder to unwind later.

**Likely follow-on work:** more heuristics, more exceptions, and eventually an
explicit mission switcher anyway.

## Recommendation

Choose **Option 2: single focus, multiple stored missions**.

It preserves Bakudo’s calm single-threaded feel in the foreground while
stopping the current ambiguity around which mission the operator is actually
talking to. It also fits the existing runtime instead of forcing either a
false single-mission world or a premature dashboard.

## Smallest high-value slice

1. Add a TUI command to list active/recent missions with status, blockers, and
   latest change.
2. Add a TUI command to focus a specific active mission by index or id prefix.
3. Reconcile focus on startup and after mission completion so the daemon and
   host layer agree on which mission is active.

This keeps the model explicit without changing the mission runtime contract.
