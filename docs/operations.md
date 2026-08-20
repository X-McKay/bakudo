# Operations

The operator guide: what runs where, how to bring the stack up, how to onboard
target repositories, and how to configure trusted performance evidence.

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
CI/bootstrap check. See [cli.md](cli.md) for the complete command and
exit-status contract.

## Bringing up the stack

```bash
cp .env.example .env      # then edit
cd infra && docker compose up -d
# Temporal UI:  http://localhost:8080
# Control API:  http://localhost:8000
```

**The composed stack is degraded-safe by default.** The worker/API image
contains no abox binary and the containers get no KVM, so the compose file
sets `BAKUDO_SANDBOX=unavailable` on both services. The worker starts and
serves everything that does not need a sandbox (ledger writes, evals on stored
results, curriculum, memory compaction), logs a loud
`sandbox posture: DEGRADED` warning at startup, and every sandbox-requiring
path fails fast with an actionable error — `POST /runs` / `POST /optimize`
return 409, sandbox activities raise — rather than hanging or silently
no-opping. To enable real sandboxing, run on a KVM-capable host and, on the
worker service: mount the host abox binary (`/usr/local/bin/abox:...:ro`),
pass through `/dev/kvm`, mount the target repos (`BAKUDO_REPO_ROOT`), and set
`BAKUDO_SANDBOX=abox` — the compose file interpolates
`${BAKUDO_SANDBOX:-unavailable}`, so exporting the variable (or putting it in
`infra/.env`) is enough; the exact stanzas are in the comments in
`infra/docker-compose.yml`.

The worker connects to Temporal and, if `BAKUDO_POSTGRES_DSN` is set, wires the
Postgres ledger and the durable `PgSemanticMemoryStore` into the activity layer
(`temporal/worker.py`) — `VLLM_EMBED_URL` is then mandatory (the worker fails
fast rather than silently using the lexical hashing embedder); if
`FALKORDB_URL` is also set, accepted memory writes are mirrored into the
FalkorDB graph through a transactional outbox (the worker applies the graph
schema at boot, dimensioning the vector index from the wired embedder;
`BAKUDO_GRAPH_GROUP_ID` namespaces the graph key).

## Model endpoints

AgentSpecs reference role-facing model ids (`model.modelId`) resolved through
the vLLM gateway. Point `infra/vllm-gateway/config.yaml` at your hosted vLLM
backends, bring the gateway up with the `models` compose profile, and set
`VLLM_BASE_URL` / `VLLM_API_KEY` (plus any per-role `BAKUDO_VLLM_<REF>`
overrides). The `agents/*.yaml` `modelId`/`baseUrlRef` values must match the
gateway configuration.

Keep `strands-agents>=1.43,<1.45` pinned (the `[runtime]` extra): strands
≥1.45 sends `tools: []` from its OpenAI-provider structured output, which vLLM
rejects, silently degrading every in-guest report extraction. Lift the cap
only after re-validating report extraction against your live deployment.

## Worker host and target-repository setup

The worker plane runs inside abox microVMs on the worker host:

- Install the `abox` binary (https://github.com/X-McKay/abox) and ensure the
  host exposes KVM (`/dev/kvm`). `bakudo doctor` reports whether abox is
  resolvable; `abox doctor` validates the runtime end to end.
- Set `BAKUDO_SANDBOX=abox`. Never use `local` outside `BAKUDO_ENV=dev`.
- Register every target repository (`bakudo repo add PATH --name NAME`).
  Registration records name, source, path, and base ref in the ledger;
  objective resolution consults the registry first. `repo remove` deregisters
  without deleting files.

**Every target repository agents operate on needs its own
`.abox/project.toml`**: the `python-glibc` guest profile, scoped network
domains for the model endpoints, and a prepare flow that installs the bakudo
runner in-guest from a vendored wheel
(`pip install vendor/bakudo-*.whl[runtime]`). Then run `abox project trust`
and `abox env warm` for the repo. `abox project init` and
`abox project set-profile` scaffold the config; this repository's own
`.abox/` is a working template.

Refresh the vendored wheel (and re-warm) whenever the control plane changes:
a stale worker-plane wheel cannot parse newer bundles — the runner reports it
as a failed result with `bundle_incompatible` rather than dying silently, but
the run still fails. Build vendor wheels with `make wheel` (SHA-stamped
versions) and use a force-reinstall prepare flow so refreshes always take
effect.

One guest policy constraint to design around: abox's in-guest command policy
denies mutating git operations (`git apply` included). Anything that needs to
materialize a diff must do it host-side before the guest starts — the
measurement and verifier runners already do (`abox/measurement.py`,
`abox/verifier.py`).

## Secrets and network policy

Provide secrets **host-side only**: `VLLM_API_KEY`, `GITHUB_TOKEN`,
`BAKUDO_API_TOKEN`, database credentials. None belong in an AgentSpec — specs
carry references, never values. Set `BAKUDO_API_TOKEN` so the control API
requires a bearer token on every route. Keep each repository's abox network
allowlist as tight as its roles need; `AboxRunner` refuses run-level
`networkMode: open` without the explicit `BAKUDO_ALLOW_NETWORK_OPEN=1` opt-in.

## Performance evidence configuration

Performance operations use explicit inputs; they never infer a trustworthy
target environment from the worker host. Configure each boundary separately:

```bash
export BAKUDO_WORKLOAD_SOURCE=/srv/bakudo/workloads
export BAKUDO_PERFORMANCE_ENVIRONMENT=/etc/bakudo/environment-pin.json
export BAKUDO_REPO_ROOT=/srv/bakudo/repos
export BAKUDO_ARTIFACT_ROOT=/srv/bakudo/performance-artifacts
export BAKUDO_SANDBOX=abox
export BAKUDO_PERFORMANCE_RUNNER=trusted
export BAKUDO_POSTGRES_DSN='postgresql://...'
```

- `BAKUDO_WORKLOAD_SOURCE` selects a versioned workload corpus directory or a
  published bundle file. Without it, only the packaged smoke workloads are
  discoverable.
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
- `BAKUDO_PERFORMANCE_RUNNER=trusted` is an explicit operator admission for
  latency decisions. `bakudo performance preflight` verifies this value,
  abox availability, an explicit non-smoke workload source, an environment
  pin, and durable Postgres evidence before any guest is started. It is
  read-only and fails closed; a generic GitHub-hosted runner is always
  rejected, even if that variable is set.

### Trusted GitHub Actions performance lane

`.github/workflows/performance-suite.yml` is a manual, self-hosted-only
invocation for one approved suite scenario. Its runner must carry the
`bakudo-performance` label and be prepared as a stable performance lab (CPU
isolation/governor policy, warmed abox profile, target checkouts, workload
corpus, and the pinned environment file). Configure the `performance-lab`
GitHub Environment with these variables, all as absolute paths on that runner:

- `BAKUDO_PERFORMANCE_WORKLOAD_SOURCE`
- `BAKUDO_PERFORMANCE_ENVIRONMENT`
- `BAKUDO_REPO_ROOT`

Store `BAKUDO_PERFORMANCE_POSTGRES_DSN` as an environment secret. The workflow
is `workflow_dispatch` only, has read-only repository permissions, and runs
`bakudo performance preflight` before resolving the supplied
`PerformanceSuiteSpec` and measuring its selected scenario. Do not add a
GitHub-hosted fallback: the preflight independently requires GitHub's
`RUNNER_ENVIRONMENT=self-hosted` identity, so a hosted machine cannot create a
latency decision.

### Authoring workloads

- The guest executes the workload's shell-free `command.argv` with the
  repository worktree (`/workspace`) as its working directory. Guest images
  ship `python3` (the `python-glibc` profile is Debian-based and has no bare
  `python`).
- Workload directories may nest members freely. abox stages every pinned
  member as a flat read-only input (guest names cannot contain `/`), and a
  fixed in-guest bootstrap reconstructs the exact pinned layout — restoring
  executable bits — under `/tmp/bakudo-workload` before the command runs, so
  reconstruction never contaminates timing. Argv entries naming workload
  members resolve against the reconstructed layout. Workload code must locate
  sibling members through its own location (`Path(__file__).parent`) or the
  exported `BAKUDO_WORKLOAD_DIR` environment variable — never through the
  working directory, which is the repository under measurement, not the
  workload.
- A member's executable bit is part of workload content identity (like a git
  tree mode) and rides bundle tar member modes, so directory- and
  bundle-distributed workloads behave identically; digests of workloads
  without executables are stable across releases.
- The environment pin's `cpuCount`/`memoryMb` must equal the workload's
  declared values, and the pin's `aboxVersion` must match the installed
  binary for diagnostic capture. Any content change to a workload requires a
  new version: the durable ledger rejects a changed manifest under an
  existing `name@version` ref.

### Measurement, capture, comparison

Measurement and diagnostic capture answer different questions. `measure`
runs the workload without instrumentation in fresh abox guests, excludes
warmups, validates every requested sample and unit, and persists raw samples in
a `MeasurementRecord`. `capture` provisions the same pinned workload/revision
in a fresh guest and runs a declared profiler to produce a
`PerformanceSnapshot` plus bounded artifact references. Capture identifies
hotspots; its duration and profiled environment are not comparison evidence.
Failed invocations persist a bounded `failureDetail` diagnostic tail.

The worker registers `PerformanceMeasurementWorkflow`,
`PerformanceCaptureWorkflow`, and `PerformanceComparisonWorkflow`. Workflow
code derives retry-stable record IDs and coordinates deterministic activity
calls; source reads, provisioning, execution, artifact I/O, statistics, and
ledger writes stay in activities. Repeated activity delivery is idempotent for
the same pins, and cancellation is relayed to the active runner. Capture is
reported as `unsupported` unless the worker is in abox mode with an artifact
root; supported profiler adapters are selected from the workload manifest.

The `bakudo performance measure/capture/compare --sync` commands provide an
explicit single-process operator path. `bakudo serve` wires a Temporal
dispatcher, so the three `POST /performance/...` endpoints return `202` plus an
`operation_id`; records are later read through
`GET /performance/records/{record_id}`. An app embedded without a dispatcher
fails create requests with `409` rather than running work on the API host.
`bakudo performance show` and `regressions` require a durable Postgres ledger
when the producing process has exited. See [cli.md](cli.md) for exact flags.

Pre-register multi-scenario objectives in a versioned `PerformanceSuiteSpec`
and run `bakudo workload validate-suite PATH --source CORPUS` before any
measurement. Resolution pins the exact workload bundle for each scenario,
checks its primary/protected metrics and paired-sample requirement, and checks
the optional profiler to use after a regression. It does not execute workloads
or create promotion evidence. When a compatible diagnostic capture is useful,
`bakudo performance profile-diff` aligns normalized snapshot hotspots for
explanation only; it cannot make a candidate eligible.

Optimization consumes this evidence rather than candidate claims. Each
candidate must first pass behavior, task, and code gates. The trusted plane
then measures the exact captured patch against the pinned baseline. Selection
accepts only a completed, integrity-valid, pin-compatible
`PerformanceComparison` whose primary metric improved and whose protected
metrics did not regress; otherwise the outcome is `no-change`.

## Curriculum collectors

`collect_signals` derives objectives from real sources; configure any subset:

- `BAKUDO_REPO_PATH` — a checked-out worktree to scan for TODO/FIXME;
- `BAKUDO_COVERAGE_XML` — a Cobertura `coverage.xml` from CI;
- `BAKUDO_JUNIT_XML` — a JUnit results file from CI;
- `GITHUB_TOKEN` — enables the GitHub issues collector.

Start `RepoObserverWorkflow` for each repository you want observed; derived
objectives appear in the meta-agent backlog (`GET /objectives` or the Temporal
query `get_backlog`). Additional collectors implement `SignalCollector` and
join `build_default_collector`.

## Autonomy posture

`MetaAgentWorkflow.mode` controls autonomy: `observe` (collect signals only),
`propose` (require approval before spawning), `sandbox-autonomous` (run in
abox, diffs+evals, no merge), `low-risk` (canary prompt-only changes, open
PRs), and `full` (continuous loops within safety boundaries, escalate gated
actions). Switch modes via the meta-agent Update API; pause/resume via
signals. Start in `observe` or `sandbox-autonomous`, decide who approves
human-gated actions (see [security.md](security.md)), and wire
`GET /promotions/pending` into your review process before increasing
autonomy.

## Observability

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
the integration-event projection point. Each run also emits an
`observability` event (tool/model calls, tokens, skills loaded, memories
retrieved) captured on the `ToolContext`, and the run budget (wall-clock
deadline + token cap) is enforced before every tool call — a breach stops the
run with a `budget:*` blocked reason rather than running away.

These spans diagnose bakudo itself. They are deliberately separate from target
`MeasurementRecord` samples and cannot establish a candidate speedup or
regression.

## CI and the local gate

`make doctor` runs the offline readiness checks. `make check` is the hermetic
local quality gate: generated-schema check, Ruff format/lint checks, mypy, and
the unit/component test tier. `make ci` is the exact GitHub Actions gate; it
also verifies `uv.lock`, exercises the offline CLI surface, and proves the
built wheel is a complete install. CI uses `uv sync --all-extras --locked`, so
dependency resolution cannot drift from the committed lockfile.

Test tiers make infrastructure requirements explicit:

- `make test-unit` runs all hermetic unit and in-memory component tests; it
  excludes `live` and `live_abox` tests.
- `make test-integration` runs the focused workload/measurement/profiler
  composition suite without external services.
- `make test-live` runs the service-marked tests, whose individual capability
  checks skip unavailable services. `make test-performance-temporal-live`
  requires a configured Temporal address, and `make test-performance-live`
  adds the trusted abox/KVM suites.

Live integrations are therefore opt-in: `make test-live` (requires the
relevant live-service environment variables) and `ABOX_LIVE=1 pytest
tests/test_abox_live.py` (requires a trusted, warmed abox project).

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
material. Corpus CI validates every task through bakudo's public source,
verifier, and bundle interfaces. Runtime trial rows persist the source URI,
corpus revision, task version, bundle digest, and verifier digest in a
`TaskPin`. Promotion requires the corpus-backed eval families
(debugging/no-change/adversarial-context/safety); the packaged smoke tasks are
packaging checks, never a promotion corpus. See
[task-corpus-and-bundles.md](task-corpus-and-bundles.md).

Performance workloads have their own source and pin contract. The core repo
contains only tiny smoke workloads; versioned target workloads, datasets, and
executors belong in a dedicated corpus or immutable published bundle selected
with `BAKUDO_WORKLOAD_SOURCE`. A `WorkloadPin` persists the source URI and
kind, collection revision, manifest/dataset/executor digests, workload
version, and bundle digest. Raw profiler artifacts belong in the configured
artifact store, not either source repository.
