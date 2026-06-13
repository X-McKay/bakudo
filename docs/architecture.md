# Architecture

bakudo is a **durable agent operating system**, not a single agent. This
document maps the [spec](spec.md) onto the code in `src/bakudo/`.

## Two planes

### Control plane (trusted)

Runs outside abox. It schedules and evaluates but never executes arbitrary
repository code. Components:

- **Meta-agent tools** (`control/tools.py`) — the *only* capabilities the
  control intelligence has (spec §4.3): create/list objectives, spawn/query/
  cancel runs, compare runs, create candidate specs/skills/evals, run eval
  suites, promote/archive candidates, query/write memory, query workflows/logs.
  There is deliberately **no** shell, filesystem, or arbitrary network tool.
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
  policy (§14.5), the in-memory/Postgres ledger of memories, and the Neo4j
  graph adapter (§14.2, §21).
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
(`run_objective`) so the system is demonstrable without a Temporal cluster — the
workflow and the pipeline call the same building blocks, so behavior matches.

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

## Eval-first evolution

The meta-agent never overwrites an active agent. It creates candidate specs/
skills/evals, scores them against a baseline, and promotes only tested
improvements — gated on zero safety regressions, sufficient eval coverage, a
minimum score improvement, and human approval for privilege-escalating
mutations. See `evals/promotion.py`.
