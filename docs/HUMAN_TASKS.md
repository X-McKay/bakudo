# Operator handoff: bringing bakudo live

This is a prompt/checklist for the **human work** that the automation cannot do
itself — provisioning infrastructure, handling secrets, activating CI, and the
judgement calls that gate autonomy. The code is in place and tested
(`make check`); these tasks turn the tested scaffold into a running system.

Treat each task as: **do the action → verify the acceptance check → tick it.**

---

## 0. Prerequisites

- [ ] Python 3.11+ and `pip install -e ".[all,dev]"`.
- [ ] `make check` passes locally (ruff + mypy + pytest).
- [ ] Decide the **autonomy mode** you will start in (`observe` is safest; see
      §26 of `docs/spec.md`). Start in `observe` or `sandbox-autonomous`.

---

## 1. Activate Python CI — DONE (PR #26 + validation branch)

The Python CI lives at `.github/workflows/ci.yml` (moved by c553243) and
installs the full `[all,dev]` extras so the API/Temporal test surface actually
runs (fixed on the 2026-08-09 validation branch).

- [x] **Acceptance:** the `CI` workflow (ruff + mypy + pytest + smoke) runs
      and is green; the legacy Rust job is gone.

---

## 2. Provision infrastructure

Bring up the local stack, or wire managed equivalents:

```bash
cp .env.example .env      # then edit
cd infra && docker compose up -d
# Temporal UI: http://localhost:8080   Control API: http://localhost:8000
```

- [x] **Postgres** reachable; `infra/postgres/init.sql` applied (the ledger
      tables exist). Set `BAKUDO_POSTGRES_DSN`. *(Applied to the live cluster
      2026-08-09; `pgcrypto` + `vector` extensions pre-created as admin.)*
- [ ] **⚠ pgvector on the live server crashes the database.** The `vector`
      0.8.2 extension on `postgresql-0` (bitnami, PG 18.3) dies with
      **signal 4 (Illegal instruction)** on the first real vector operation,
      taking the whole server into recovery (observed 2026-08-09 16:38 GMT;
      likely a build/CPU mismatch, e.g. AVX-512 codegen on a node without it).
      Until the extension binary is rebuilt for the node's CPU (or the image
      is swapped for one with a matching pgvector build), do NOT run
      semantic-memory writes/queries against the live DB — the worker wires
      the pg store whenever `BAKUDO_POSTGRES_DSN` is set, so either fix the
      extension or run the worker without memory-compaction workflows.
      **Acceptance:** `tests/test_store_pg_live.py` passes against the live
      DSN without the server crashing.
- [ ] **Neo4j** reachable; `infra/neo4j/init.cypher` applied (constraints exist).
- [ ] **Temporal** cluster reachable at `TEMPORAL_ADDRESS`; namespace created.
- [ ] **Acceptance:** `bakudo-worker` connects and serves the task queues; the
      Temporal UI lists the worker.

---

## 3. Stand up vLLM + the gateway, and map models to roles

The AgentSpecs reference role-facing model ids (`model.modelId`) resolved via
`infra/vllm-gateway/config.yaml`. You must host the models and decide the
mapping (spec open question §28.3).

- [ ] Deploy vLLM backends (e.g. `qwen-coder-32b`, `critic-large`).
- [ ] Point `infra/vllm-gateway/config.yaml` `api_base`s at them; set
      `VLLM_BASE_URL` / `VLLM_API_KEY` (and any `BAKUDO_VLLM_<REF>` overrides).
- [ ] Confirm the `agents/*.yaml` `modelId`/`baseUrlRef` match the gateway.
- [ ] **Acceptance:** a one-off real run (not `BAKUDO_OFFLINE`) returns a
      schema-valid `result.json` through the gateway; per-role token budgets and
      rate limits are configured on the gateway.

---

## 4. Install and configure abox (the isolation boundary)

The worker plane runs inside abox microVMs. Sandbox selection **fails closed**.

- [x] Install the `abox` binary on the worker host (see
      https://github.com/X-McKay/abox). *(0.6.0 validated end-to-end
      2026-08-09: offline + live-model runs through real microVMs.)*
- [x] Set `BAKUDO_SANDBOX=abox` (never `local` outside `BAKUDO_ENV=dev`).
- [ ] **Every target repo agents operate on needs its own `.abox/project.toml`**
      with a prepare flow that installs the bakudo runner in-guest (vendor the
      wheel: `pip install vendor/bakudo-*.whl[runtime]`), the `python-glibc`
      profile, and scoped network domains for the model endpoints — then
      `abox project trust` + `abox env warm` per repo. See
      `.abox/` in this repo and the optfix fixture pattern for templates.
      **⚠ Refresh the vendored wheel (and re-warm) whenever the control plane
      changes** — a stale worker-plane wheel can't parse newer bundles
      (observed live 2026-08-09; the runner now reports it as a failed result
      with `bundle_incompatible` instead of dying silently, but the run still
      fails). A future improvement: automated version handshake at bundle load.
- [ ] Define the abox sandbox profiles named in `abox/runner.py::PROFILES`
      (`explore-readonly`, `add-feature-python`, `optimize-python`, …) with the network bundles
      (`github-api`, `pypi-public`, `vllm-gateway`) and resource/diff limits.
- [ ] Validate the real `abox run` flags against
      `AboxRunner.build_command` (the contract test pins the shape; confirm the
      installed abox CLI accepts `--task/--base/--branch/--timeout/--template/
      --mount` or adjust the runner).
- [ ] **Acceptance:** a real sandboxed run produces a diff on the
      `agent/<run_id>` branch and a collected `result.json`; denied commands and
      denied egress appear in the run's audit log.

---

## 5. Secrets and network policy (human-owned)

- [ ] Provide secrets **host-side only**: `VLLM_API_KEY`, `GITHUB_TOKEN`,
      `BAKUDO_API_TOKEN`, DB creds. None belong in an AgentSpec.
- [ ] Set `BAKUDO_API_TOKEN` so the control API requires a bearer token.
- [ ] Review the abox outbound allowlist; keep it as tight as the role needs.
- [ ] **Acceptance:** worker agents cannot reach anything outside their
      bundles; `GET /promotions/pending` and mutating routes enforce the token.

---

## 6. Configure the curriculum collector (now wired)

`collect_signals` is live; point it at real sources via env (any subset):

- [ ] `BAKUDO_REPO_PATH` → a checked-out worktree to scan for TODO/FIXME.
- [ ] `BAKUDO_COVERAGE_XML` → a Cobertura `coverage.xml` from your CI.
- [ ] `BAKUDO_JUNIT_XML` → a JUnit results file from your CI.
- [ ] `GITHUB_TOKEN` → enables the GitHub issues collector for `owner/name`.
- [ ] Start `RepoObserverWorkflow` for each repo you want observed.
- [ ] **Acceptance:** objectives derived from real signals appear in the
      meta-agent backlog (`GET /objectives` / the Temporal query `get_backlog`).

> Optional: implement additional collectors (dependency advisories, security
> scanners) by adding a `SignalCollector` and including it in
> `build_default_collector`.

---

## 7. Grow the eval corpora (judgement work)

Promotion requires `promotionPolicy.minEvalCases` (25) real cases. The sample
`evals/corpora/add-feature.yaml` has two. `evals/corpora/optimize.yaml` meets
the 25-case bar with synthetic planted inefficiencies + no-change decoys;
replace/extend those with real history as it accumulates.

- [ ] For each role, curate ≥25 cases from real objectives + historical
      failures (use the `eval-author` role to convert failures into cases).
- [ ] Configure an LLM critic judge (`evals/critic.llm_judge`) and add the
      `critic` suite to the corpus run where you want review gating.
- [ ] Decide the production `PromotionPolicy` (required suites incl. a
      `regression` corpus, score threshold, canary %).
- [ ] **Acceptance:** `AgentEvolutionWorkflow` can promote a genuinely-better
      candidate and rejects a regression, on real corpora.

---

## 8. Durable memory store (engineering done; operator decisions remain)

The durable store is implemented: `PgSemanticMemoryStore`
(`src/bakudo/memory/store_pg.py`) persists memories in `memory_items` +
`memory_embeddings` with server-side pgvector similarity, and the worker wires
it automatically whenever `BAKUDO_POSTGRES_DSN` is set (with a Neo4j graph
mirror when `NEO4J_URI`/`NEO4J_PASSWORD` are set). What remains is judgement:

- [ ] Decide repo-scoped vs org-wide memory (spec open question §28.10) —
      writes are currently scoped `{"repo": ...}` by compaction.
- [ ] Once a production embedder is fixed (the default `HashingEmbedder` is
      256-dim and lexical), retype `memory_embeddings.embedding` to
      `vector(<dim>)` and add the HNSW index (see the comment in
      `infra/postgres/init.sql`), and optionally enable the Neo4j vector index
      in `infra/neo4j/init.cypher` with matching dimensions.
- [ ] **Acceptance:** memories written by one run are retrievable by a later
      run (semantic `query-memory` returns them across processes).

---

## 9. Set the autonomy posture (the real gate)

- [ ] Choose the operating mode and who approves human-gated actions
      (broader network, new secrets, production-write tools, self-modification,
      memory deletion, promotion-policy changes, high-risk merges).
- [ ] Wire `GET /promotions/pending` into your review process.
- [ ] Decide whether code changes ship as branches, patches, or PRs
      (spec open question §28.9).
- [ ] **Acceptance:** a dry-run objective flows end-to-end (observe → run →
      eval → candidate → `needs_human`) and pauses at the human gate as expected.

---

## Quick reference — what's already done (no human work)

Schemas, AgentSpec model, curriculum + **live collectors**, the run pipeline,
Temporal workflows (run/eval/meta/observer/evolution/compaction/optimization),
scoped tools with command policy + budget + observability, skills registry,
eval suite + corpus runner + critic (+ perf/simplicity graders), scorecard +
promotion (safety/human gates), semantic memory + write policy + compaction
(+ the durable pgvector store, worker-wired), the optimization loop with its
25-case corpus and `bakudo optimize` / `POST /optimize` entrypoints, the
in-memory and Postgres ledgers, the control API (+ auth), the CLI, and the
Makefile/CI definition. All covered by `make check`.
