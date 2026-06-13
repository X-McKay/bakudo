# Operations

## What runs without infrastructure

The control-plane domain logic depends only on the light core deps (`pydantic`,
`pyyaml`, `jsonschema`). With no Temporal/Postgres/Neo4j/abox/vLLM you can:

- validate AgentSpecs (`bakudo validate-spec`),
- list skills (`bakudo skills`),
- run an objective end-to-end via the **local sandbox** + **offline driver**
  (`bakudo demo`), which exercises the full lifecycle (bundle → sandbox →
  result → eval → scorecard),
- run the control API in-process (`bakudo serve`),
- run the test suite (`pytest`).

The local sandbox (`abox/local.py`) is **not** a security boundary — it runs the
runner in-process against a throwaway git workspace. It exists to make the
pipeline demonstrable; production runs go through abox.

## What needs live infrastructure

| Capability | Needs | Extra |
|---|---|---|
| Durable orchestration, signals/queries/updates, Continue-As-New | Temporal cluster | `temporal` |
| Authoritative ledger across processes | Postgres | `db` |
| Relationship/graph memory queries | Neo4j | `db` |
| Real model inference | vLLM gateway | `runtime` |
| MicroVM isolation, scoped network, audit logs | abox | (external binary) |
| HTTP control surface | FastAPI/uvicorn | `api` |

Install everything with `pip install -e ".[all,dev]"`.

## Operational modes (spec §26)

The `MetaAgentWorkflow.mode` controls autonomy: `observe` (collect signals
only), `propose` (require approval before spawning), `sandbox-autonomous` (run
in abox, diffs+evals, no merge), `low-risk` (canary prompt-only changes, open
PRs), and `full` (continuous loops within safety boundaries, escalate gated
actions). Switch modes via the meta-agent Update API; pause/resume via signals.

## Bringing up the stack

```bash
cp .env.example .env
cd infra && docker compose up -d
# Temporal UI:  http://localhost:8080
# Control API:  http://localhost:8000
```

The worker connects to Temporal and, if `BAKUDO_POSTGRES_DSN` is set, wires the
Postgres ledger into the activity layer (`temporal/worker.py`). Model traffic is
routed through the vLLM gateway; bring it up with the `models` compose profile
once you have hosted vLLM backends configured in `infra/vllm-gateway/config.yaml`.

## Observability (spec §18)

- **Temporal**: workflow status, activity retries, history size, timeouts —
  via the Temporal UI.
- **abox**: sandbox lifecycle, console/audit logs, denied commands/HTTP, exit
  code, diff stats — surfaced into `AboxOutcome` and the run event log.
- **Agent**: model/tool/MCP calls, skills discovered/loaded, memories
  retrieved/proposed, schema validation — recorded on the `ToolContext` and in
  `result.json`.

The Postgres `run_events` table is the durable event log; the `outbox` table is
the integration-event projection point (spec §17.1).

## Build order (spec §29)

This repo implements the recommended order: (1) schemas, (2) agent-runner,
(3) abox activity, (4) Temporal workflows, (5) Postgres ledger, (6) first roles
`explore`/`add-feature`/`qa` (+`critic`), (7) first evals, (8) skill registry,
(9) memory pipeline, (10) candidate evolution (prompt-mutation + eval comparison
+ canary). Remaining work: live regression eval corpora, the curriculum
`RepoObserver`, and skill/memory *curation* workflows.
