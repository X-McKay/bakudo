# Operations

## What runs without infrastructure

The control-plane domain logic depends only on the light core deps (`pydantic`,
`pyyaml`, `jsonschema`). With no Temporal/Postgres/Neo4j/abox/vLLM you can:

- validate AgentSpecs (`bakudo validate-spec`),
- list skills (`bakudo skills`),
- run an objective end-to-end via the **local sandbox** + **offline driver**
  (`bakudo demo`), which exercises the full lifecycle (bundle → sandbox →
  result → eval → scorecard),
- run the optimization loop end-to-end (`bakudo optimize --repo ... --title
  ...`) — scout → attempts → gated selection, offline by default,
- run the control API in-process (`bakudo serve`),
- run the test suite (`pytest`).

The local sandbox (`abox/local.py`) is **not** a security boundary — it runs the
runner in-process against a throwaway git workspace. It exists to make the
pipeline demonstrable; production runs go through abox.

Sandbox selection **fails closed**: the Temporal activity layer refuses to pick
a sandbox implicitly. Set `BAKUDO_SANDBOX=abox` (production) or
`BAKUDO_SANDBOX=local` (which additionally requires `BAKUDO_ENV=dev`). The
offline CLI/demo path calls the local sandbox directly and is unaffected.

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
Postgres ledger and the durable `PgSemanticMemoryStore` into the activity layer
(`temporal/worker.py`) — `VLLM_EMBED_URL` is then mandatory (the worker fails
fast rather than silently using the lexical hashing embedder); if `NEO4J_URI`
is also set, accepted memory writes are mirrored into the graph. *(The Neo4j
mirror is frozen pending the FalkorDB migration — leave `NEO4J_URI` unset.)* Model traffic is
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
the integration-event projection point (spec §17.1). Each run also emits an
`observability` event (tool/model calls, tokens, skills loaded, memories
retrieved) captured on the `ToolContext`, and the run budget (wall-clock
deadline + token cap) is enforced before every tool call — a breach stops the
run with a `budget:*` blocked reason rather than running away.

## CI and types

`make check` runs the full local gate (`ruff` + `mypy` + `pytest`). The Python
CI workflow lives at `.github/workflows/ci.yml` and installs the full
`[all,dev]` extras so the API/Temporal/memory test surface runs in CI.
Live-integration tests are opt-in: `pytest -m live` (needs live-service env
vars) and `ABOX_LIVE=1 pytest tests/test_abox_live.py` (needs a trusted,
warmed abox project).

## Build order (spec §29)

This repo implements the recommended order: (1) schemas, (2) agent-runner,
(3) abox activity, (4) Temporal workflows, (5) Postgres ledger, (6) first roles
`explore`/`add-feature`/`qa` (+`critic`), (7) first evals, (8) skill registry,
(9) memory pipeline, (10) candidate evolution (prompt-mutation + eval comparison
+ canary). Beyond that order, the following are implemented:

- the curriculum `RepoObserver` with live TODO/coverage/JUnit/GitHub
  collectors (configured via `BAKUDO_REPO_PATH` / `BAKUDO_COVERAGE_XML` /
  `BAKUDO_JUNIT_XML` / `GITHUB_TOKEN`);
- the evolution and memory-compaction workflows, the eval-corpus runner, and
  the LLM critic grader;
- **the optimization loop** — `OptimizationWorkflow`: an `optimize-scout`
  proposes approaches, parallel single-hypothesis `optimize-attempt` runs
  implement them in sibling sandboxes, and perf/simplicity graders plus hard
  behavior-preservation gates pick a winner or return no-change, looping with
  feedback accumulated across bounded rounds. The winner's benchmark claim is
  **independently re-measured** before selection returns (diff applied
  host-side to a `verify/` branch, timed best-of-3 in fresh network-isolated
  sandboxes; unreproduced claims are rejected with feedback). Every run is
  bounded by the spec-level `budget.maxToolCalls` ceiling and ends with a
  guided structured-output report extraction regardless of how the loop
  terminated. Submit via `bakudo optimize` or `POST /optimize` (both drive
  the in-process mirror `run_optimize_loop`); production submits the Temporal
  workflow via `temporal.client.start_optimization`;
- **durable semantic memory** — `PgSemanticMemoryStore` over pgvector,
  auto-wired in the worker from `BAKUDO_POSTGRES_DSN`, with an optional Neo4j
  graph mirror from `NEO4J_URI`/`NEO4J_PASSWORD`;
- budget enforcement, observability counters, and API auth.

Remaining work: curating eval corpora from real historical failures — the
optimize corpus meets the 25-case `minEvalCases` bar with synthetic planted
cases, while `add-feature` is still a 2-case sample. See
`docs/HUMAN_TASKS.md` for the operator handoff.
