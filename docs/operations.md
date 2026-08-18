# Operations

## What runs without infrastructure

The control-plane domain logic depends only on the light core deps (`pydantic`,
`pyyaml`, `jsonschema`). With no Temporal/Postgres/FalkorDB/abox/vLLM you can:

- diagnose the local configuration without contacting services (`bakudo doctor`),
- inspect and validate AgentSpecs (`bakudo agent list`, `bakudo agent validate`),
- list runtime skills (`bakudo skill list`),
- run an objective end-to-end via the **local sandbox** + **offline driver**
  (`bakudo demo`), which exercises the full lifecycle (bundle → sandbox →
  result → eval → scorecard),
- run the control API in-process (`bakudo serve`),
- load, inspect, publish, and author-verify local task bundles (`bakudo task`;
  verifier execution requires `BAKUDO_ENV=dev`),
- inspect and validate the packaged or configured performance workload corpus
  (`bakudo workload`) without executing target code,
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
| Relationship/graph memory queries | FalkorDB | `db` |
| Real model inference | vLLM gateway | `runtime` |
| MicroVM isolation, scoped network, audit logs | abox | (external binary) |
| Trusted uninstrumented workload measurement | abox, clean target checkout, explicit `EnvironmentPin` | (external binary) |
| Durable measurement/snapshot/comparison records | Postgres | `db` |
| Diagnostic capture | isolated provisioned workspace, profiler adapter, artifact store | adapter-specific |
| HTTP control surface | FastAPI/uvicorn | `api` |

Install everything with `pip install -e ".[all,dev]"`.

Run `bakudo doctor` after installation or configuration changes. It validates
packaged AgentSpecs, runtime skill discovery, configured task/workload sources,
the artifact root, abox measurement availability, the default performance
environment, profiler capabilities, optional imports, execution posture, and
persistence configuration without connecting to Postgres or another external
service. Use `--json` for tooling and `--strict` when warnings should fail a
CI/bootstrap check. See
[cli.md](cli.md) for the complete command and exit-status contract.

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

**Sandbox posture: the composed stack is degraded by default (TMP-13).** The
worker/API image contains no abox binary and the containers get no KVM, so the
compose file sets `BAKUDO_SANDBOX=unavailable` on both services. The worker
starts and serves everything that does not need a sandbox (ledger writes,
evals on stored results, curriculum, memory compaction), logs a loud
`sandbox posture: DEGRADED` warning at startup, and every sandbox-requiring
path fails fast with an actionable error — `POST /runs` / `POST /optimize`
return 409, sandbox activities raise — rather than hanging or silently
no-opping. To enable real sandboxing, run on a KVM-capable host and, on the
worker service: mount the host abox binary (`/usr/local/bin/abox:...:ro`),
pass through `/dev/kvm`, mount the target repos (`BAKUDO_REPO_ROOT`), and set
`BAKUDO_SANDBOX=abox` — the compose file interpolates
`${BAKUDO_SANDBOX:-unavailable}`, so exporting the variable (or putting it in
`infra/.env`) is enough; the exact stanzas are in the comments in
`infra/docker-compose.yml`. **Breaking default change:** the compose file
previously shipped `BAKUDO_SANDBOX: abox`; if you had enabled sandboxing by
only adding the abox mount and `/dev/kvm`, you must now also set
`BAKUDO_SANDBOX=abox` yourself.

The worker connects to Temporal and, if `BAKUDO_POSTGRES_DSN` is set, wires the
Postgres ledger and the durable `PgSemanticMemoryStore` into the activity layer
(`temporal/worker.py`) — `VLLM_EMBED_URL` is then mandatory (the worker fails
fast rather than silently using the lexical hashing embedder); if
`FALKORDB_URL` is also set, accepted memory writes are mirrored into the
FalkorDB graph through a transactional outbox (the worker applies the graph
schema at boot, dimensioning the vector index from the wired embedder;
`BAKUDO_GRAPH_GROUP_ID` namespaces the graph key). Model traffic is
routed through the vLLM gateway; bring it up with the `models` compose profile
once you have hosted vLLM backends configured in `infra/vllm-gateway/config.yaml`.

## Performance evidence configuration

Performance operations use explicit inputs; they never infer a trustworthy
target environment from the worker host. Configure each boundary separately:

```bash
export BAKUDO_WORKLOAD_SOURCE=/srv/bakudo/workloads
export BAKUDO_PERFORMANCE_ENVIRONMENT=/etc/bakudo/environment-pin.json
export BAKUDO_REPO_ROOT=/srv/bakudo/repos
export BAKUDO_ARTIFACT_ROOT=/srv/bakudo/performance-artifacts
export BAKUDO_SANDBOX=abox
```

- `BAKUDO_WORKLOAD_SOURCE` selects a versioned workload corpus or published
  bundle. Without it, only the packaged smoke workloads are discoverable.
- `BAKUDO_PERFORMANCE_ENVIRONMENT` points to a JSON/YAML `EnvironmentPin`.
  Every measurement/capture request carries that complete pin.
- `BAKUDO_REPO_ROOT` constrains repository resolution for durable activities.
  A revision must belong to the requested repository and a baseline must be
  clean; candidate patches are bound by digest.
- `BAKUDO_ARTIFACT_ROOT` enables the durable, content-addressed directory
  artifact store used by profiler capture. Treat it as restricted evidence:
  raw profiles can disclose code paths even though paths and metadata are
  normalized before persistence.
- `BAKUDO_POSTGRES_DSN` makes measurements, snapshots, comparisons, and
  regression signals durable across worker/API processes.

Workload directories may nest members freely. abox stages every pinned member
as a flat read-only input (guest names cannot contain `/`), and a fixed
in-guest bootstrap reconstructs the exact pinned layout — restoring executable
bits — under `/tmp/bakudo-workload` before the command argv runs, so
reconstruction never contaminates timing. A member's executable bit is part
of workload content identity (like a git tree mode) and rides bundle tar
member modes, so directory- and bundle-distributed workloads behave
identically; digests of workloads without executables are unchanged from
earlier releases. The command runs with the repository
worktree (`/workspace`) as its working directory, and argv entries naming
workload members resolve against the reconstructed layout. Workload code must
locate sibling members through its own location (`Path(__file__).parent`) or
the exported `BAKUDO_WORKLOAD_DIR` environment variable — never through the
working directory, which is the repository under measurement, not the
workload. Guest images ship `python3` (the `python-glibc` profile is
Debian-based and has no bare `python`).

Measurement and diagnostic capture answer different questions. `measure`
runs the workload without instrumentation in fresh abox guests, excludes
warmups, validates every requested sample and unit, and persists raw samples in
a `MeasurementRecord`. `capture` provisions the same pinned workload/revision
in a fresh guest and runs a declared profiler to produce a
`PerformanceSnapshot` plus bounded artifact references. Capture identifies
hotspots; its duration and profiled environment are not comparison evidence.

The worker registers `PerformanceMeasurementWorkflow`,
`PerformanceCaptureWorkflow`, and `PerformanceComparisonWorkflow`. Workflow
code derives retry-stable record IDs and coordinates deterministic activity
calls; source reads, provisioning, execution, artifact I/O, statistics, and
ledger writes stay in activities. Repeated activity delivery is idempotent for
the same pins, and cancellation is relayed to the active runner. Capture is
reported as `unsupported` unless the worker is in abox mode with an artifact
root; supported profiler adapters are selected from the workload manifest.

The `bakudo performance measure/capture/compare --sync` commands provide an
explicit single-process operator path. `bakudo serve` wires a Temporal dispatcher, so
the three `POST /performance/...` endpoints return `202` plus an
`operation_id`; records are later read through
`GET /performance/records/{record_id}`. An app embedded without a dispatcher
fails create requests with `409` rather than running work on the API host.
`bakudo performance show` and `regressions` require a durable Postgres ledger
when the producing process has exited. See [cli.md](cli.md) for exact flags.

Optimization consumes this evidence rather than candidate claims. Each
candidate must first pass behavior, task, and code gates. The
trusted plane then measures the exact captured patch against the pinned
baseline. Selection accepts only a completed, integrity-valid, pin-compatible
`PerformanceComparison` whose primary metric improved and whose protected
metrics did not regress; otherwise the outcome is `no-change`.

## Observability (spec §18)

- **Temporal**: workflow status, activity retries, history size, timeouts —
  via the Temporal UI.
- **abox**: sandbox lifecycle, console/audit logs, denied commands/HTTP, exit
  code, diff stats — surfaced into `AboxOutcome` and the run event log.
- **Agent**: model/tool/MCP calls, skills discovered/loaded, memories
  retrieved/proposed, schema validation — recorded on the `ToolContext` and in
  `result.json`.
- **Phase spans**: bounded monotonic spans around run, bundle, sandbox, report,
  verifier, measurement, statistical-analysis, and ledger boundaries. Pure
  summaries expose p50/p95 latency, exclusive time, and error/timeout rates
  with low-cardinality attributes.

The Postgres `run_events` table is the durable event log; the `outbox` table is
the integration-event projection point (spec §17.1). Each run also emits an
`observability` event (tool/model calls, tokens, skills loaded, memories
retrieved) captured on the `ToolContext`, and the run budget (wall-clock
deadline + token cap) is enforced before every tool call — a breach stops the
run with a `budget:*` blocked reason rather than running away.

These spans diagnose Bakudo itself. They are deliberately separate from target
`MeasurementRecord` samples and cannot establish a candidate speedup or
regression.

## CI and types

`make doctor` runs the offline readiness checks; `make check` runs the full
local gate (`ruff` + `mypy` + `pytest`). The Python
CI workflow lives at `.github/workflows/ci.yml` and installs the full
`[all,dev]` extras so the API/Temporal/memory test surface runs in CI.
Live-integration tests are opt-in: `pytest -m live` (needs live-service env
vars) and `ABOX_LIVE=1 pytest tests/test_abox_live.py` (needs a trusted,
warmed abox project).

Use a unique task queue to validate the performance workflows against a hosted
cluster without running target code:

```bash
make test-performance-temporal-live \
  TEMPORAL_ADDRESS=temporal.example.com:7233 \
  TEMPORAL_NAMESPACE=bakudo \
  PYTHON=.venv/bin/python
```

The smoke runs deterministic injected invocations through real Temporal
measurement, comparison, and software-artifact experiment workflows. The full
`make test-performance-live` target adds the opt-in real abox/KVM suites.

## Task and workload sources

Bakudo defaults to exactly two packaged smoke tasks. Real experiments should
set `BAKUDO_TASK_SOURCE` to a checkout of the private `bakudo-benchmarks`
corpus, or to a locally cached published task bundle:

```bash
export BAKUDO_TASK_SOURCE="$HOME/git/bakudo-benchmarks"
bakudo task list --json
BAKUDO_ENV=dev bakudo task verify rate-limiter-fix
```

The core repository does not own the benchmark corpus or privileged verifier
material. Corpus CI validates all 25 tasks through Bakudo's public source,
verifier, and bundle interfaces. Runtime trial rows persist the source URI,
corpus revision, task version, bundle digest, and verifier digest in a
`TaskPin`. See [task-corpus-and-bundles.md](task-corpus-and-bundles.md).

Performance workloads have their own source and pin contract. The core repo
contains only tiny smoke workloads; versioned target workloads, datasets, and
executors belong in a dedicated corpus or immutable published bundle selected
with `BAKUDO_WORKLOAD_SOURCE`. A `WorkloadPin` persists the source URI and
kind, collection revision, manifest/dataset/executor digests, workload
version, and bundle digest. Raw profiler artifacts belong in the configured
artifact store, not either source repository.

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
  the sandboxed critic evaluator;
- **the optimization loop** — `OptimizationWorkflow`: an `optimize-scout`
  proposes approaches and parallel single-hypothesis `optimize-attempt` runs
  implement them in sibling sandboxes. Hard behavior/task/code
  gates run before the trusted plane captures each exact patch and creates a
  fresh baseline/candidate `PerformanceComparison` under the objective's
  workload, environment, metric, confidence, and protected-metric policy.
  Only eligible comparisons may win; unsupported, invalid, inconclusive, or
  regressed evidence yields feedback or `no-change`. Every run is bounded by
  `budget.maxToolCalls` and ends with guided report extraction. Submit via
  `bakudo optimize` or `POST /optimize`; production uses the Temporal workflow;
- **the workload/performance substrate** — immutable workload, revision, and
  environment pins; fresh abox measurement; diagnostic capture with restricted
  content-addressed artifacts; deterministic bootstrap comparisons; durable
  regression policy; and retry-stable Temporal workflows/API dispatch;
- **durable semantic memory** — `PgSemanticMemoryStore` over pgvector,
  auto-wired in the worker from `BAKUDO_POSTGRES_DSN`, with an optional
  FalkorDB graph mirror from `FALKORDB_URL` (outboxed, so a mirror outage
  never loses a graph write);
- budget enforcement, phase-level self-observability, and API auth.

Remaining corpus work is operational: populate private task and workload
sources from representative historical failures and target-repository
performance cases, publish immutable bundles, and retain privileged verifier
or dataset material outside core. The private `bakudo-benchmarks` task corpus
meets the 25-case `minEvalCases` bar for
debugging/no-change/adversarial-context/safety; core smoke assets are package
and integration checks only. See `docs/HUMAN_TASKS.md` for the operator handoff.
