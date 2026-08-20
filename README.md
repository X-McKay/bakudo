# bakudo

**A durable agent operating system.** bakudo creates, runs, evaluates, and
evolves specialized software agents — and measures the software they change —
with independently verified evidence at every step.

bakudo is not a single autonomous agent. It is a trusted control plane that
supervises many small, sharply constrained agents, built on Temporal, Strands,
[abox](https://github.com/X-McKay/abox), Postgres, FalkorDB, and vLLM. Its
central principle:

> Every agent is a versioned artifact. Every run is evaluated. Every
> improvement is proposed as a candidate, tested, and promoted only if it
> improves measurable outcomes.

## What it does

- **Runs agents safely.** Each versioned agent executes inside an abox microVM
  on its own git worktree, with an allowlisted tool/skill surface, scoped
  network egress, budgets, and a schema-valid output contract. The control
  plane schedules and evaluates but never executes repository code.
- **Evaluates agents on controlled tasks.** Versioned `TaskSpec` environments
  with privileged, out-of-process verifiers produce immutable `TrialRecord`
  evidence; paired experiments compare agent versions with honest statistics
  (bootstrap confidence intervals, tie zones, integrity hard gates).
- **Measures software performance with trusted evidence.** Versioned,
  shell-free `WorkloadSpec`s run uninstrumented in fresh microVM guests
  against exact revision/environment pins, producing `MeasurementRecord`
  samples, diagnostic `PerformanceSnapshot`s, and statistically eligible
  `PerformanceComparison`s. Agent-reported timing never enters a decision.
- **Evolves agents eval-first.** The meta-agent proposes candidate specs,
  skills, and evals; candidates are scored against baselines and promoted only
  through hard safety gates, minimum-improvement thresholds, and human
  approval for privilege-escalating changes.

## Architecture

Two planes with a hard trust boundary:

| Plane | Trust | What runs there |
|---|---|---|
| **Control plane** | trusted | meta-agent, registry/ledger, curriculum, eval coordination, memory services, promotion and optimization logic. Schedules and evaluates; never executes arbitrary repo code. |
| **Worker plane** | untrusted | individual versioned agents, each inside an abox microVM on its own git worktree, with scoped tools/skills/MCP and an explicit output contract. |

```
Human / API / Scheduler
        │
     Temporal ──> MetaAgentWorkflow ──> AgentRunWorkflow ──> abox microVM ──> Strands agent ──> vLLM
        │               │                     │                                    │
   (signals/queries) Registry/Curriculum   EvalWorkflow                      Scoped tools / Skills / MCP
        │               │                     │
     Postgres (ledger)  └── FalkorDB (graph memory)
```

See [docs/architecture.md](docs/architecture.md) for the component map and
[docs/security.md](docs/security.md) for the trust model.

## Repository layout

```
src/bakudo/
  agent_spec/    versioned, declarative AgentSpec model + loader
  curriculum/    objective model, prioritization formula, queues
  agent_run_bundle.py  per-run payload handed to an agent worker
  runner/        the worker-plane agent runner: prompts, Strands agent, result
  strands_tools/ scoped, policy-enforced worker tools
  skills/        Open Agent Skills registry with progressive disclosure
  abox/          abox sandbox runner, workload staging, measurement, capture,
                 verifier execution, and a local in-process sandbox for dev
  evals/         eval levels, scorecard, promotion policy
  tasks/         TaskSpec models, sources, published bundles, provisioning,
                 verifier protocol, and authoring verification
  experiments/   explicit agent/artifact subjects, normalized observations,
                 paired statistics, and replaceable subject bindings
  performance/   WorkloadSpec contracts, immutable pins, measurement and
                 comparison statistics, profiler capture, artifact stores,
                 regression policy, and replaceable runner/source ports
  observability/ safe phase spans and latency/outcome summaries for bakudo
  memory/        evidence-backed memory model, write policy, semantic stores
                 (in-process + durable pgvector), FalkorDB graph
  registry/      the authoritative ledger (in-memory + Postgres)
  temporal/      workflows, activities, worker, client
  control/       run pipeline, the optimization loop, and the meta-agent's
                 administrative tools
  api/           FastAPI control surface
  cli.py         the `bakudo` operator CLI and grouped command surface
  doctor.py      read-only, independently testable local readiness checks
schemas/         JSON Schemas: AgentSpec, TaskSpec, WorkloadSpec, performance
                 records, ExperimentSpec, Objective, and results
agents/          seed AgentSpecs: explore, add-feature, qa, critic,
                 optimize-scout, optimize-attempt
skills/          seed skills: codebase-navigation, test-selection, safe-refactor
smoke/           two paired smoke tasks plus a tiny public performance
                 workload; private benchmark/workload corpora live elsewhere
infra/           docker-compose, Postgres DDL, vLLM gateway
docs/            architecture, CLI, operations, environment model, security
```

## Getting started (offline, no infrastructure)

The control-plane domain logic runs with only the light core dependencies — no
Temporal, Postgres, FalkorDB, abox, or vLLM required.

```bash
pip install -e ".[all,dev]"

# Check packaged resources, source configuration, optional dependencies,
# execution posture, and persistence without contacting external services.
bakudo doctor

# Validate a seed agent spec against the JSON Schema + pydantic model.
bakudo agent validate agents/add-feature.yaml

# List discoverable skills (names + descriptions only).
bakudo skill list

# Run a sample objective end-to-end with the offline sandbox driver:
# agent-run bundle -> local sandbox -> result.json -> eval suite -> scorecard.
bakudo demo

# Inspect the packaged smoke tasks and performance workload.
bakudo task list
bakudo workload list
bakudo workload inspect smoke-python-loop@1.0.1 --json

pytest
```

Trusted measurement is deliberately not part of the infrastructure-free path:
it requires an explicit `EnvironmentPin`, a clean repository revision, and
abox. The synchronous operator path is explicit:

```bash
bakudo repo add /path/to/checkout --name my-service

bakudo performance measure --sync --repo my-service \
  --workload WORKLOAD@VERSION --source /path/to/workload-corpus \
  --environment /path/to/environment-pin.json --ref HEAD --json

bakudo performance compare --sync --repo my-service \
  --workload WORKLOAD@VERSION --source /path/to/workload-corpus \
  --environment /path/to/environment-pin.json \
  --baseline-ref BASELINE --candidate-ref CANDIDATE \
  --primary-metric latency_seconds --json
```

## Running the full stack

```bash
cp .env.example .env                    # then edit
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

Real sandboxing needs a KVM-capable worker host with the abox binary; the
composed stack is degraded-safe by default. The complete operator guide —
worker host setup, target-repository onboarding, model endpoints, performance
evidence configuration, and autonomy posture — is
[docs/operations.md](docs/operations.md).

## Documentation

| Guide | Covers |
|---|---|
| [architecture.md](docs/architecture.md) | The two planes, run lifecycle, workflows, optimization loop, experiment and performance substrates |
| [cli.md](docs/cli.md) | The complete `bakudo` command surface, JSON conventions, exit statuses, and common workflows |
| [operations.md](docs/operations.md) | Operator guide: infrastructure, worker host and target-repo setup, performance evidence configuration, observability |
| [environment-model.md](docs/environment-model.md) | Formal terminology: tasks, trials, experiments, workloads, measurements, pins, and their boundaries |
| [experiment-loop.md](docs/experiment-loop.md) | Conceptual overview of the experiment loop: tasks, trials, paired experiments, deployment model |
| [task-corpus-and-bundles.md](docs/task-corpus-and-bundles.md) | Benchmark corpus ownership, published bundle format, and trial provenance |
| [security.md](docs/security.md) | Trust model, sandbox boundary, command policy, human-gated actions |
| [spec.md](docs/spec.md) | The detailed design specification; its section numbers (§N) are cited throughout the code and docs |

## Maintaining the repository

Repository-local guidance for coding agents lives in the `bakudo-maintenance`
skill under `.claude/skills/` and `.codex/skills/`; bakudo's runtime agents use
the separately packaged skills under `skills/`. The full local gate:

```bash
make doctor
make check      # hermetic schemas + Ruff format/lint + mypy + tests
make ci         # check + uv-lock validation + CLI and wheel smoke tests
```

Keep runtime models, JSON Schemas, packaged smoke data, and the docs above in
sync when changing a contract.

## License

Apache-2.0. See [LICENSE](LICENSE).
