# Operations

## What runs without infrastructure

The control-plane domain logic depends only on the light core deps (`pydantic`,
`pyyaml`, `jsonschema`). With no Temporal/Postgres/FalkorDB/abox/vLLM you can:

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

Sandbox selection **fails closed** on every path — the Temporal activity layer
and the synchronous CLI/API pipeline share one resolver
(`bakudo.abox.select.resolve_sandbox`) that refuses to pick a sandbox
implicitly. Set `BAKUDO_SANDBOX=abox` (production) or `BAKUDO_SANDBOX=local`
(which additionally requires `BAKUDO_ENV=dev` or `BAKUDO_OFFLINE=1`). Offline
mode (`BAKUDO_OFFLINE=1`, the `bakudo demo`/`bakudo optimize` default) resolves
to the local sandbox because the offline driver never invokes a model or tools.

## What needs live infrastructure

| Capability | Needs | Extra |
|---|---|---|
| Durable orchestration, signals/queries/updates, Continue-As-New | Temporal cluster | `temporal` |
| Authoritative ledger across processes | Postgres | `db` |
| Relationship/graph memory queries | FalkorDB | `db` |
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
(`temporal/worker.py`); if `FALKORDB_URL` is also set, accepted memory writes are
mirrored into the graph. Model traffic is
routed through the vLLM gateway; bring it up with the `models` compose profile
once you have hosted vLLM backends configured in `infra/vllm-gateway/config.yaml`.

**`bakudo doctor`** checks each configured dependency (config validity,
sandbox resolution, abox binary, Temporal, Postgres+pgvector, FalkorDB, the
model gateway) with 2-second timeouts — unset optional dependencies are
skips, configured-but-broken ones fail the exit status. Run it first when
anything misbehaves.

Concurrent sandbox executions pass an **admission gate**
(`bakudo.abox.gate`, width `min(16, max(2, cores*2))`, override with
`BAKUDO_SANDBOX_CONCURRENCY`) so attempt fan-outs and corpus runs queue
instead of stampeding the microVM host.

Every process logs **structured JSON lines** to stderr (`bakudo.log`), with
the canonical run id attached to records inside a run — the log stream is
parseable analytics substrate, not prose. The API's `POST /runs` and
`POST /optimize` return **202 Accepted** with a status URL and execute in the
background; poll `GET /runs/{id}` / `GET /optimize/{objective_id}`.

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
CI workflow is active at `.github/workflows/ci.yml` and mirrors `make check`
plus an offline smoke of the operator surface and the **eval gate**
(`scripts/eval_gate.py`): a deterministic FauxDriver corpus through the real
pipeline, snapshot-compared against `evals/baselines/eval-gate.json`. Any
grader-behaviour drift fails CI until a human reviews it and refreshes the
baseline with `--update` — you cannot silently defang an eval.

The test suite includes real Temporal workflow tests
(`tests/test_workflows_temporal.py`) under the SDK's time-skipping test
environment; they skip gracefully where the test server cannot be downloaded.

## Eval corpora and fixtures

The optimize corpus (`evals/corpora/optimize.yaml`) executes against its
fixture repository `evals/fixtures/payments-api` (20 planted inefficiencies +
5 no-change decoys, with per-case benchmarks):

    bakudo eval-corpus evals/corpora/optimize.yaml \
        --agent-spec agents/optimize-attempt.yaml [--limit N]

Benchmarks and complexity are measured by the **harness**, not the agent
(`bakudo.evals.measure`): median-of-N wall clock with a warm-up run, before
and after the change, overwriting any agent-claimed metrics. Promotion now
also requires the `regression` suite — a corpus comparison in which no
baseline-passing case fails (`bakudo.evals.evolution.regression_result`).

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
  feedback across bounded rounds. Submit via `bakudo optimize` or
  `POST /optimize` (both drive the in-process mirror `run_optimize_loop`);
  production submits the Temporal workflow via
  `temporal.client.start_optimization`;
- **durable semantic memory** — `PgSemanticMemoryStore` over pgvector,
  auto-wired in the worker from `BAKUDO_POSTGRES_DSN`, with an optional FalkorDB
  graph mirror from `FALKORDB_URL`;
- budget enforcement, observability counters, and API auth.

Remaining work: curating eval corpora from real historical failures — the
optimize corpus meets the 25-case `minEvalCases` bar with synthetic planted
cases, while `add-feature` is still a 2-case sample. See
`docs/HUMAN_TASKS.md` for the operator handoff.
