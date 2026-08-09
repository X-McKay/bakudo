# Promotion lifecycle + critic — wave-2 design proposal

Status: DRAFT — awaiting user review before implementation.
Fixes: OPT-4, OPT-5, OPT-6, OPT-7/API-7, OPT-8, API-6 (findings doc
`docs/superpowers/reviews/2026-08-09-post-refactor-review-findings.md`).
Spec anchors: §15 (evolution loop), §15.3 (policy), §23.3 (target demo),
§25.3 (approve route), §9.1 + §21 critic-eval ("did a review agent find
serious issues?").

## 1. Version lifecycle (state machine on `AgentVersionRecord`)

```
candidate ──decide()──► rejected            (with reason; terminal)
candidate ──decide()──► pending_human       (human-gated mutations / policy)
pending_human ──approve──► canary           (POST /promotions/{id}/approve)
pending_human ──reject───► rejected
candidate ──decide()──► canary              (auto, when no human gate)
canary ──graduate──► active                 (previous active → archived)
canary ──rollback──► rejected               (canary underperforms)
active ──superseded──► archived
```

- `agent_spec_versions` gains a `status` column
  (`candidate|pending_human|canary|active|rejected|archived`) + `status_reason`,
  `decided_at`. The first version registered for a name becomes `active`.
- `promotion_decisions` gains `status` (`pending|approved|rejected|superseded`),
  `approved_by`, `comment`, `resolved_at`.

## 2. Enforcement at spawn (fixes OPT-5)

`_resolve_spec(name)` (control/tools.py + ledger) returns the **active**
version only — never candidates/rejected/archived. Canary routing: when a
`canary` version exists, route `hash(run_id) % 100 < policy.canary.percent`
of spawns to it (deterministic per run_id → replay-safe inside Temporal,
trivially testable, no wall-clock randomness). Everything else gets `active`.

## 3. Canary graduation (fixes OPT-6)

After each finished canary run, an activity checks: if the canary version has
`>= policy.canary.minRuns` completed runs, compare mean `overall_score` and
hard counters (safety_regressions == 0, critical_failures == 0) of canary runs
vs the active version's trailing runs over the same window. Better-or-equal →
`graduate` (canary → active, old active → archived, decision recorded);
worse → `rollback` (canary → rejected, decision recorded). All transitions are
ledger writes with events — no silent state.

## 4. Approvals (fixes OPT-7/API-7/API-6)

- Route per spec §25.3: `POST /promotions/{promotion_id}/approve` with
  `{approved_by, comment}` (+ a mirror `/reject`). The old
  `/promotions/approve` (caller-supplied scorecards) is REMOVED.
- Scorecards are read from the ledger's `eval_results` — never from the
  request body. `mutation_kinds` come from the stored candidate record, so
  human-gated mutations cannot be laundered.
- `Ledger.promotions(status=...)` joins the protocol; `PostgresLedger`
  implements read/resolve so `GET /promotions/pending` works on the durable
  ledger.

## 5. Critic (fixes OPT-8) — the one real trade-off

**Chosen (recommended): direct LLM-judge eval.** `critic_eval` calls the judge
model directly from the eval layer (OpenAI-compatible call to the role-mapped
endpoint; `llm-fast` for cheap gating by default, configurable to the 35B) with
a fixed review rubric and a pinned JSON verdict schema
`{score: 0..1, passed: bool, issues: [str]}` (aligned with
`schemas/eval-result.schema.json`). Behavior changes:
- configured + judge call fails → the suite ERRORS (no silent pass);
- not configured → the critic suite is **omitted from the scorecard** entirely
  (today's abstention fabricates score 1.0);
- non-dict / non-numeric verdicts → structured error, one retry, then fail.
`agents/critic.yaml`'s result contract is aligned to the same verdict schema.

**Alternative (spec §9.1-faithful, deferred):** run the `critic` role as a real
read-only sandboxed agent over the candidate branch and grade its result.
Heavier (sandbox + model per eval) and depends on the abox path just being
repaired; proposed as a follow-up issue, not this wave.

## 6. Required suites default (fixes OPT-4)

Default `required_suites` becomes spec §15.3's `("safety", "regression",
"role-specific")` plus `code`. A policy naming a suite with no corpus backing
it fails the decision loudly (`missing required suite`) instead of silently
passing. The optimize corpus's decoy guarantee becomes real: `role-specific`
is required, so failing decoys blocks promotion.

## 7. Out of scope this wave

Kafka/NATS fanout (spec anti-goal), skill promotion (§13.4), the sandboxed
critic agent (deferred above), FalkorDB/graph anything.
