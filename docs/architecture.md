# Architecture

bakudo is a **durable agent operating system**, not a single agent. This
document maps the [spec](spec.md) onto the code in `src/bakudo/`.

## Two planes

### Control plane (trusted)

Runs outside abox. It schedules and evaluates but never executes arbitrary
repository code. Components:

- **Meta-agent tools** (`control/tools.py`) — the *only* capabilities the
  control intelligence has (spec §4.3): create/list objectives, spawn runs
  (sync or 202-style async)/query/cancel, compare runs, register candidate
  specs, promote candidates and advance canaries, archive, query/write
  memory, query logs. There is deliberately **no** shell, filesystem, or
  arbitrary network tool — and no second eval entry point (evaluation happens
  inside the shared run pipeline only).
- **Curriculum** (`curriculum/`) — the objective model, the priority formula
  (§16.4), and the named queues (§16.3).
- **Registry / ledger** (`registry/`) — the authoritative record of agent
  versions, runs, the run event log, evals, and promotions. In-memory for dev
  and tests; Postgres for production (`registry/postgres_ledger.py`, DDL in
  `infra/postgres/init.sql`).
- **Evals & promotion** (`evals/`) — eval levels (§22.1), the scorecard
  (§15.2), and the promotion policy with hard safety gates and human gates
  (§15.3, §19.2).
- **Memory services** (`memory/`) — evidence-backed memory items, the write
  policy (§14.5), the in-process `SemanticMemoryStore` (embedding dedup +
  retrieval) and its durable counterpart `PgSemanticMemoryStore` (pgvector
  similarity server-side, auto-wired in the worker from
  `BAKUDO_POSTGRES_DSN`), and the FalkorDB graph adapter with an optional
  memory-write mirror (§14.2, §21).
- **Temporal** (`temporal/`) — durable orchestration (see below).
- **Control API** (`api/`) — the HTTP surface (§25).

### Worker plane (untrusted)

Runs inside abox. The **agent runner** (`runner/`) is the only bakudo code that
executes in the sandbox. It loads one versioned `AgentSpec`, builds a thin
Strands agent (`runner/agent.py`) wired to vLLM, exposes only the declared
scoped tools (`strands_tools/`) and skills (`skills/`), runs against one
objective, and writes a schema-valid `result.json` (`runner/result.py`).

## The run lifecycle

`AgentRunWorkflow` (`temporal/workflows.py`) implements the phases of §12.1:

```
created → bundle_rendered → sandbox_starting → agent_running
        → collecting_artifacts → evaluating → completed | failed | cancelled
```

Each phase transition is persisted to the ledger via the `persist_run`
activity. The same lifecycle runs **synchronously** in `control/pipeline.py`
(`run_objective`) so the system is demonstrable without a Temporal cluster.
The phase functions themselves — `build_bundle`, `enforce_sandbox_budgets`,
`grade_run` — exist once in `control/pipeline.py` and both drivers call them,
so the eval context, schema gate, and budget enforcement cannot diverge
between paths. Sandbox executions additionally pass a process-wide admission
gate (`abox/gate.py`) so fan-outs queue instead of stampeding the microVM
host.

### Activities vs workflows

Per §11.2, workflows are deterministic orchestration only; every side effect is
an activity (`temporal/activities.py`, implemented in `temporal/_impl.py`):
rendering the bundle, running the sandbox, persisting runs, running the eval
suite, and deciding promotions. The implementations live in plain functions so
they are unit-testable without the Temporal SDK.

## The long-running meta-agent

`MetaAgentWorkflow` is an **entity workflow** (§11.3): it holds durable
high-level state (mode, active objectives/runs, pending promotions, budgets,
concurrency limits), reacts to **Signals** (`new_objective`, `run_completed`,
`pause/resume_autonomy`), answers **Queries** (`get_status`, `get_backlog`), and
accepts validated **Updates** (`submit_objective`, `change_budget`,
`change_concurrency_limit`). It uses **Continue-As-New** to bound history.

## Identifiers

One canonical ULID flows through every system (§6.3): Temporal workflow id,
abox task id, Postgres run id, the `agent/<run_id>` git branch, and the log
correlation id. See `ids.py`.

## The optimization loop

`OptimizationWorkflow` applies the same judge-panel shape to *code* that
evolution applies to agent specs. A read-only `optimize-scout` proposes
distinct hypotheses; parallel single-hypothesis `optimize-attempt` child
runs implement them in sibling sandboxes on their own branches; graders
(`perf`/`simplicity` on **harness-measured** before/after metrics — the
sandbox times the benchmark itself and overwrites agent claims, see
`evals/measure.py` — on top of the default suite) score each candidate; and
a pure selection function
(`control/optimize.py`) picks a winner or returns `no-change`, feeding
failure summaries into the next scout round (bounded rounds). The fan-out
lives in the trusted plane — workers never schedule their own sub-agents —
and behavior preservation is a hard gate, not a weighted score. "No safe
improvement found" is a success outcome; the optimize eval corpus plants
no-change decoys so churn cannot be promoted. `run_optimize_loop` is the
synchronous in-process mirror (used by `bakudo optimize` and
`POST /optimize`), the same relationship `run_objective` has to
`AgentRunWorkflow`.

## Eval-first evolution

The meta-agent never overwrites an active agent. It creates candidate specs/
skills/evals, scores them against a baseline over a corpus (including the
`regression` level: no baseline-passing case may fail), and promotes only
tested improvements — gated on zero safety regressions, sufficient eval
coverage, a minimum score improvement, and human approval for
privilege-escalating mutations. See `evals/promotion.py`.

A `canary` decision enters the **automated canary lifecycle**
(`control/canary.py`): the candidate is registered, a deterministic
`canary_percent` slice of dispatches routes to it, every completed run feeds
observation, and `canary_min_runs` clean runs promote it (an observed safety
regression rolls it back) with no manual step. When `BAKUDO_CRITIC_MODEL` is
configured (after `bakudo critic-calibrate` passes), a **gated LLM critic**
joins every run suite — free triage decides obvious verdicts, only ambiguous
runs spend a judge call (`evals/critic.py`).
