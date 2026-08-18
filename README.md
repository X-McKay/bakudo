# bakudo

**A durable, always-running meta-agent operating system.** bakudo creates, runs,
evaluates, and evolves specialized agents over time.

> This is a ground-up redesign (v3). Earlier versions of bakudo were a Rust TUI/
> daemon for driving coding agents. bakudo is now a Python **agent operating
> system** built on Temporal, Strands, abox, Postgres, FalkorDB, and vLLM. See the
> [system spec](docs/spec.md) and [architecture](docs/architecture.md).

## The idea

bakudo is not a single autonomous agent — it is a control plane that supervises
many small, sharply-constrained agents. Its central principle:

> Every agent is a versioned artifact. Every run is evaluated. Every improvement
> is proposed as a candidate, tested, and promoted only if it improves
> measurable outcomes.

It borrows the useful parts of Voyager-style lifelong learning — an automatic
curriculum, a growing skill library, iterative improvement from environment
feedback, and explicit memory — **without** model fine-tuning.

## Two planes

| Plane | Trust | What runs there |
|---|---|---|
| **Control plane** | trusted | the meta-agent, registry, curriculum, eval coordination, memory services, promotion logic. Schedules and evaluates; never executes arbitrary repo code. |
| **Worker plane** | untrusted | individual versioned agents, each inside an [abox](https://github.com/X-McKay/abox) microVM sandbox on its own git worktree, with scoped tools/skills/MCP and an explicit output contract. |

```
Human / API / Scheduler
        │
     Temporal ──> MetaAgentWorkflow ──> AgentRunWorkflow ──> abox microVM ──> Strands agent ──> vLLM
        │               │                     │                                    │
   (signals/queries) Registry/Curriculum   EvalWorkflow                      Scoped tools / Skills / MCP
        │               │                     │
     Postgres (ledger)  └── FalkorDB (graph memory)
```

## What's in this repo

```
src/bakudo/
  agent_spec/    versioned, declarative AgentSpec model + loader (§8)
  curriculum/    objective model, prioritization formula, queues (§16)
  agent_run_bundle.py  per-run payload handed to an agent worker (§5.3)
  runner/        the worker-plane agent runner: prompts, Strands agent, result (§7, §12.2)
  strands_tools/ scoped, policy-enforced worker tools (§4.3, §8)
  skills/        Open Agent Skills registry with progressive disclosure (§13)
  abox/          abox sandbox runner + a local in-process sandbox for dev (§6)
  evals/         eval levels, scorecard, promotion policy (§15, §22)
  tasks/         TaskSpec models, sources, published bundles, provisioning,
                 verifier protocol, and authoring verification
  experiments/   explicit agent/artifact subjects, normalized observations,
                 paired statistics, and replaceable subject bindings
  performance/   WorkloadSpec contracts, immutable pins, measurement and
                 comparison statistics, profiler capture, artifact stores,
                 regression policy, and replaceable runner/source ports
  observability/ safe phase spans and latency/outcome summaries for Bakudo
  memory/        evidence-backed memory model, write policy, semantic stores
                 (in-process + durable pgvector), FalkorDB graph (§14)
  registry/      the authoritative ledger (in-memory + Postgres) (§14.1, §20)
  temporal/      workflows, activities, worker, client (§11, §12)
  control/       run pipeline, the optimization loop, and the meta-agent's
                 administrative tools (§4.3)
  api/           FastAPI control surface (§25)
  cli.py         the `bakudo` operator CLI and grouped command surface
  doctor.py      read-only, independently testable local readiness checks
schemas/         JSON Schemas, including AgentSpec, TaskSpec, WorkloadSpec,
                 performance records, ExperimentSpec, Objective, and results
agents/          seed AgentSpecs: explore, add-feature, qa, critic,
                 optimize-scout, optimize-attempt (§9)
skills/          seed skills: codebase-navigation, test-selection, safe-refactor
smoke/           two paired task smoke cases plus small public performance
                 workloads; private benchmark/workload corpora live elsewhere
infra/           docker-compose, Postgres DDL, vLLM gateway (§20, §21, §24)
docs/            spec, architecture, security, operations
```

## Quickstart (offline, no infra)

The control-plane domain logic runs with only the light core dependencies — no
Temporal, Postgres, FalkorDB, abox, or vLLM required.

```bash
pip install -e ".[all,dev]"

# Check packaged resources, task-source configuration, optional dependencies,
# execution posture, and persistence without contacting external services.
bakudo doctor

# Validate a seed agent spec against the JSON Schema + pydantic model.
bakudo agent validate agents/add-feature.yaml

# List discoverable skills (names + descriptions only — progressive disclosure).
bakudo skill list

# Run a sample objective end-to-end with the offline sandbox driver:
# agent-run bundle -> local sandbox -> result.json -> eval suite -> scorecard.
bakudo demo

# Inspect the two packaged smoke tasks. Point BAKUDO_TASK_SOURCE at a private
# corpus checkout or a locally cached published bundle for real experiments.
bakudo task list

# Inspect the packaged performance workload. Point BAKUDO_WORKLOAD_SOURCE at a
# versioned workload corpus or immutable bundle for target-repository evidence.
bakudo workload list
bakudo workload inspect smoke-python-loop@1.0.0 --json

pytest
```

Trusted measurement is deliberately not part of the infrastructure-free
quickstart: it requires an explicit `EnvironmentPin`, a clean repository
revision, and abox. The local operator path is explicit:

```bash
bakudo performance measure --sync --repo /path/to/checkout \
  --workload WORKLOAD@VERSION --source /path/to/workload-corpus \
  --environment /path/to/environment-pin.json --ref HEAD --json

bakudo performance compare --sync --repo /path/to/checkout \
  --workload WORKLOAD@VERSION --source /path/to/workload-corpus \
  --environment /path/to/environment-pin.json \
  --baseline-ref BASELINE --candidate-ref CANDIDATE --json

BAKUDO_ARTIFACT_ROOT=/path/to/restricted-artifacts \
bakudo performance capture --sync --repo /path/to/checkout \
  --workload WORKLOAD@VERSION --source /path/to/workload-corpus \
  --environment /path/to/environment-pin.json --ref HEAD \
  --profiler PROFILER --json
```

## Running the full stack

```bash
cp .env.example .env
cd infra && docker compose up -d        # postgres, falkordb, temporal(+UI), worker, api
# Temporal UI at http://localhost:8080, control API at http://localhost:8000
```

Submit an objective:

```bash
curl -X POST localhost:8000/objectives -H 'content-type: application/json' -d '{
  "repo": "payments-api",
  "type": "add-feature",
  "title": "Add retry handling to webhook delivery",
  "acceptanceCriteria": ["Retries transient 5xx with backoff", "Does not retry 4xx"]
}'
```

## Maintaining the repository

Repository-local guidance is available to both Claude and Codex through the
`bakudo-maintenance` skill under `.claude/skills/` and `.codex/skills/`.
Bakudo's runtime agents use the separately packaged skills under `skills/`.
After focused tests, run the complete local gate from an environment installed
with `.[all,dev]`:

```bash
ruff check src tests skills scripts
python -m mypy src/bakudo
python -m pytest
```

Keep runtime models, JSON Schemas, packaged smoke data, and canonical docs in
sync. The formal terminology is defined in
[the environment model](docs/environment-model.md); benchmark ownership and
artifact provenance are defined in
[the task corpus guide](docs/task-corpus-and-bundles.md). The complete command
surface, JSON conventions, exit statuses, and common workflows are documented
in [the CLI guide](docs/cli.md). Canonical workload-backed measurement,
diagnostic capture, comparison, proactive regression, and Bakudo
self-observability terms are defined in the environment model and architecture.
The detailed [performance design](docs/superpowers/specs/2026-08-17-performance-measurement-design.md)
is retained as a design record, not as a future-facing API contract.

## Status

This is a **v0.2 active-development vertical slice** following the spec's recommended build order
(§29). The control-plane domain logic — schemas, agent specs, task/environment
contracts, curriculum, evals/promotion, memory policy, ledger, the run pipeline,
and the meta-agent tool surface — is implemented and tested in-process. The Temporal workflows,
abox microVM runner, Strands/vLLM model wiring, and Postgres/FalkorDB adapters are
implemented against their real client libraries (installed via extras) and
exercised through the same building blocks the offline pipeline uses.

A follow-up hardening pass closed the highest-risk seams: the safety gate now
sees denied commands on every run path; the ledger is a single sync Protocol
backed by either in-memory or Postgres (`psycopg`), with run records created and
advanced uniformly; sandbox selection **fails closed**; promotion enforces
`required_suites`; worker tools preserve their signatures for Strands; and
`query-memory` is wired to the bundle's excerpts.

Several larger slices have since landed. **Durable semantic memory**:
`PgSemanticMemoryStore` persists policy-gated memories with server-side
pgvector similarity (worker auto-wires it from `BAKUDO_POSTGRES_DSN`, with an
optional FalkorDB mirror), so memories written by one run are retrievable by
later runs. **The optimization loop**: `OptimizationWorkflow` (and its offline
mirror behind `bakudo optimize` / `POST /optimize`) fans an optimize objective
out to a read-only scout, parallel single-hypothesis attempt runs in sibling
sandboxes, and hard-gated winner selection that treats "no safe improvement"
as a first-class outcome. Candidate timing is not trusted: optimization now
requires an immutable `WorkloadPin`, fresh uninstrumented baseline/candidate
measurements, compatible `RevisionPin` and `EnvironmentPin` values, valid
integrity evidence, and a statistically eligible `PerformanceComparison`.
The 25-task benchmark corpus, including paired no-change tasks that make
manufactured churn unpromotable, lives in the dedicated private
`bakudo-benchmarks` repository and is consumed through immutable
content-addressed bundles.

The **performance substrate** adds a separate workload corpus and evidence
family. A `MeasurementRecord` contains uninstrumented samples from isolated
invocations; a `PerformanceSnapshot` contains diagnostic profiler output and
restricted content-addressed artifacts; and a `PerformanceComparison`
recomputes statistics from raw paired samples and fails closed on missing
data, pin incompatibility, profiled environments, or integrity violations.
Temporal workflows provide retry-stable measurement, capture, and comparison
operations. The synchronous CLI exposes measurement/comparison explicitly
with `--sync`, while the API exposes durable create/read routes through an
injected dispatcher. Approved repeated regressions can become deduplicated
optimization objectives.

The experiment substrate accepts two explicit subject kinds. Agent-spec
experiments analyze embedded `TrialRecord` evidence; software-artifact
experiments analyze only persisted `MeasurementRecord` IDs for immutable
revision/workload/environment pins. Both share direction-aware paired
statistics, while invalid artifact evidence is contagious and ineligible.
Behavioral `experiment profile` remains agent-only and does not mean profiler
capture.

Vendor-neutral phase spans cover Bakudo run, sandbox, report, verifier,
measurement, statistics, and ledger boundaries. Their bounded,
low-cardinality summaries identify control-plane latency without treating
operational telemetry as target-repository performance evidence.

Earlier 2026-08 hardening passes took the production plane **live end-to-end**
(real abox microVMs — 0.6.0 then, 0.7.1 now — Temporal + Postgres, hosted vLLM models) and
restructured the run-report path that live runs proved fragile:

- **The run report is a phase, not a side effect** (issue #27): every loop
  ending — clean finish, budget/timeout, the spec-level `budget.maxToolCalls`
  ceiling, the denial circuit-breaker — force-transitions into one guided
  structured-output report extraction, so the deliverable survives however
  the loop ends.
The report terminal and fail-closed sandbox posture are live-proven on fixture
repositories. See
[docs/superpowers/reviews/](docs/superpowers/reviews/) for the validation
reports, including the live failure ladder. Note the pinned
`strands-agents>=1.43,<1.45` (1.45+ breaks structured output against vLLM).

See the [environment model and terminology](docs/environment-model.md),
[task corpus and bundle model](docs/task-corpus-and-bundles.md),
[full system design](docs/spec.md), [operations guide](docs/operations.md), and
[performance measurement design record](docs/superpowers/specs/2026-08-17-performance-measurement-design.md).

## License

Apache-2.0. See [LICENSE](LICENSE).
