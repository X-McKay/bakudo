# bakudo

**A durable, always-running meta-agent operating system.** bakudo creates, runs,
evaluates, and evolves specialized agents over time.

> This is a ground-up redesign (v3). Earlier versions of bakudo were a Rust TUI/
> daemon for driving coding agents. bakudo is now a Python **agent operating
> system** built on Temporal, Strands, abox, Postgres, Neo4j, and vLLM. See the
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
     Postgres (ledger)  └── Neo4j (graph memory)
```

## What's in this repo

```
src/bakudo/
  agent_spec/    versioned, declarative AgentSpec model + loader (§8)
  curriculum/    objective model, prioritization formula, queues (§16)
  bundle.py      the task bundle handed to a worker run (§5.3)
  runner/        the worker-plane agent runner: prompts, Strands agent, result (§7, §12.2)
  strands_tools/ scoped, policy-enforced worker tools (§4.3, §8)
  skills/        Open Agent Skills registry with progressive disclosure (§13)
  abox/          abox sandbox runner + a local in-process sandbox for dev (§6)
  evals/         eval levels, scorecard, promotion policy (§15, §22)
  memory/        evidence-backed memory model, write policy, Postgres+Neo4j (§14)
  registry/      the authoritative ledger (in-memory + Postgres) (§14.1, §20)
  temporal/      workflows, activities, worker, client (§11, §12)
  control/       run pipeline + the meta-agent's administrative tools (§4.3)
  api/           FastAPI control surface (§25)
  cli.py         the `bakudo` operator CLI
schemas/         JSON Schemas: AgentSpec, Objective, RunResult, EvalResult (§29.1)
agents/          seed AgentSpecs: explore, add-feature, qa, critic,
                 optimize-scout, optimize-attempt (§9)
skills/          seed skills: codebase-navigation, test-selection, safe-refactor
infra/           docker-compose, Postgres DDL, Neo4j schema, vLLM gateway (§20, §21, §24)
docs/            spec, architecture, security, operations
```

## Quickstart (offline, no infra)

The control-plane domain logic runs with only the light core dependencies — no
Temporal, Postgres, Neo4j, abox, or vLLM required.

```bash
pip install -e ".[dev]"

# Validate a seed agent spec against the JSON Schema + pydantic model.
bakudo validate-spec agents/add-feature.yaml

# List discoverable skills (names + descriptions only — progressive disclosure).
bakudo skills

# Run a sample objective end-to-end with the offline sandbox driver:
# bundle -> local sandbox -> result.json -> eval suite -> scorecard.
bakudo demo

pytest
```

## Running the full stack

```bash
cp .env.example .env
cd infra && docker compose up -d        # postgres, neo4j, temporal(+UI), worker, api
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

## Status

This is a **v0.1 vertical slice** following the spec's recommended build order
(§29). The control-plane domain logic — schemas, agent specs, curriculum,
evals/promotion, memory policy, registry, the run pipeline, and the meta-agent
tool surface — is implemented and tested in-process. The Temporal workflows,
abox microVM runner, Strands/vLLM model wiring, and Postgres/Neo4j adapters are
implemented against their real client libraries (installed via extras) and
exercised through the same building blocks the offline pipeline uses.

A follow-up hardening pass closed the highest-risk seams: the safety gate now
sees denied commands on every run path; the ledger is a single sync Protocol
backed by either in-memory or Postgres (`psycopg`), with run records created and
advanced uniformly; sandbox selection **fails closed**; promotion enforces
`required_suites`; worker tools preserve their signatures for Strands; and
`query-memory` is wired to the bundle's excerpts.

See [docs/spec.md](docs/spec.md) for the full design and [docs/operations.md](docs/operations.md)
for what is wired end-to-end versus what needs live infrastructure.

## License

Apache-2.0. See [LICENSE](LICENSE).
