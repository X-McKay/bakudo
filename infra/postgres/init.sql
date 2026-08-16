-- bakudo authoritative ledger (spec sections 14.1 and 20).
-- Postgres is the source of truth for agent specs, objectives, runs, the run
-- event log, eval results, memories, and promotion decisions.

create extension if not exists "pgcrypto";   -- gen_random_uuid()
-- pgvector for embedding search (spec section 14.1); the compose image is
-- pgvector/pgvector so the extension is always available here.
create extension if not exists vector;

create table if not exists agent_specs (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  active_version int,
  created_at timestamptz not null default now()
);

create table if not exists agent_spec_versions (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  version int not null,
  spec_yaml text not null,
  -- Version lifecycle state machine (promotion design 2026-08-09 §1):
  -- candidate, pending_human, canary, active, rejected, archived.
  status text not null,
  status_reason text,              -- why the last transition happened
  decided_at timestamptz,          -- when the last transition happened
  parent_version int,
  created_by text not null,
  created_at timestamptz not null default now(),
  unique (name, version)
);

create table if not exists objectives (
  id text primary key,
  repo text not null,
  type text not null,
  title text not null,
  objective_json jsonb not null,
  status text not null,
  priority numeric,
  created_at timestamptz not null default now()
);

create table if not exists runs (
  id text primary key,
  temporal_workflow_id text not null,
  abox_task_id text not null,
  objective_id text references objectives(id),
  agent_ref text not null,
  status text not null,            -- run phase (section 12.1)
  git_branch text,
  started_at timestamptz,
  completed_at timestamptz,
  -- Terminal result.json stored on finish_run (TMP-9), matching the
  -- in-memory reference ledger.
  result jsonb
);

create table if not exists run_events (
  id bigserial primary key,
  run_id text references runs(id),
  ts timestamptz not null default now(),
  event_type text not null,
  payload jsonb not null default '{}',
  -- Caller-computed idempotency key (TMP-8): a retried Temporal activity
  -- re-issues the same logical event; unique (run_id, idem_key) plus
  -- `on conflict do nothing` in the writer drops the duplicate. NULL keys
  -- (ad-hoc events) always append.
  idem_key text,
  unique (run_id, idem_key)
);
create index if not exists run_events_run_id_ts on run_events (run_id, ts);

create table if not exists run_artifacts (
  id uuid primary key default gen_random_uuid(),
  run_id text references runs(id),
  artifact_type text not null,
  path text not null,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table if not exists eval_suites (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  description text,
  suite_json jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table if not exists eval_cases (
  id uuid primary key default gen_random_uuid(),
  suite_id uuid references eval_suites(id),
  name text not null,
  case_json jsonb not null,
  created_at timestamptz not null default now()
);

create table if not exists eval_results (
  id uuid primary key default gen_random_uuid(),
  subject_type text not null,      -- run, agent_spec_version, skill_version, ...
  subject_id text not null,
  suite_name text not null,
  score numeric not null,
  passed boolean not null,
  details jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index if not exists eval_results_subject on eval_results (subject_id);

create table if not exists skills (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  active_version int,
  created_at timestamptz not null default now()
);

create table if not exists skill_versions (
  id uuid primary key default gen_random_uuid(),
  skill_id uuid references skills(id),
  version text not null,
  path text not null,
  status text not null,
  created_by text not null,
  created_at timestamptz not null default now(),
  unique (skill_id, version)
);

create table if not exists memory_items (
  id text primary key,
  memory_type text not null,
  scope jsonb not null,
  content text not null,
  evidence jsonb not null,
  confidence numeric not null,
  ttl interval,
  created_by text not null,
  created_at timestamptz not null default now()
);

-- Embedding search support (PgSemanticMemoryStore). The column is typed to
-- the production embedder's dimension: Qwen/Qwen3-Embedding-0.6B emits 1024
-- (pinned by the live probe test in tests/test_embeddings.py). Typing the
-- column enables the HNSW index below, and PgSemanticMemoryStore reads the
-- column typmod at connect time and rejects any embedder whose dimension
-- does not match (MEM-4). Consequence, by design: the 256-dim dev
-- HashingEmbedder cannot write to this schema.
create table if not exists memory_embeddings (
  memory_id text references memory_items(id) on delete cascade,
  embedding vector(1024) not null
);
-- Idempotent retype for databases created before the column was typed; the
-- DO block skips the table rewrite when the column is already vector(1024).
-- (Fails if pre-existing rows carry a different dimension — that data was
-- written by a non-production embedder and must be migrated or dropped.)
do $$
begin
  if (select atttypmod from pg_attribute
      where attrelid = to_regclass('memory_embeddings')
        and attname = 'embedding') is distinct from 1024 then
    alter table memory_embeddings alter column embedding type vector(1024);
  end if;
end $$;
create index if not exists memory_embeddings_embedding_hnsw
  on memory_embeddings using hnsw (embedding vector_cosine_ops);

create table if not exists promotion_decisions (
  -- Canonical bakudo id (prom_<ULID>), supplied by the writer so activity
  -- retries collide instead of duplicating rows.
  id text primary key,
  subject_type text not null,
  subject_id text not null,
  decision text not null,          -- promote, reject, canary, needs_human
  rationale text not null,
  scorecard jsonb not null,
  -- Decision lifecycle (design 2026-08-09 §1): human-gated decisions are
  -- recorded pending and resolved via POST /promotions/{id}/approve|reject.
  status text not null,            -- pending, approved, rejected, superseded
  approved_by text,
  comment text,
  resolved_at timestamptz,
  gated_mutations jsonb not null default '[]',
  requires_human boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists promotion_decisions_status on promotion_decisions (status);

-- Graph-mirror outbox (MEM-3): each accepted memory write enqueues its
-- FalkorDB mirror op here inside the same transaction as the memory row;
-- PgSemanticMemoryStore.flush_graph_mirror() drains it best-effort after
-- commit and from compaction (serialised via pg_try_advisory_xact_lock so
-- drainers never interleave). A mirror outage therefore never loses the
-- graph write, and a retried activity re-delivers instead of dropping it.
-- Rows failing mirror_max_attempts times are parked (dead = true) so a
-- poison payload cannot wedge the queue; parked rows are kept for operator
-- inspection and never retried automatically.
--
-- CANONICAL DDL — mirrored by _GRAPH_MIRROR_OUTBOX_DDL in
-- src/bakudo/memory/store_pg.py, which self-migrates existing databases
-- (this file only runs at first initialization). Keep the two in sync.
create table if not exists graph_mirror_outbox (
  id bigserial primary key,
  op text not null,                -- upsert | delete
  memory_id text not null,
  run_id text,
  payload jsonb not null default '{}',  -- type, confidence, embedding
  attempts int not null default 0,
  dead boolean not null default false,
  created_at timestamptz not null default now()
);

-- Trials (experiment substrate design doc section 6): one agent-version run
-- of one scenario version, with its metrics, evaluation, and hack-detection
-- flags. Insert-only — a trial's outcome is immutable once recorded.
--
-- CANONICAL DDL — mirrored by _TRIALS_DDL in
-- src/bakudo/registry/postgres_ledger.py, which self-migrates existing
-- databases (this file only runs at first initialization). Keep the two in
-- sync.
create table if not exists trials (
  id text primary key,
  experiment_id text,
  run_id text,
  objective_id text,
  agent_ref text not null,
  scenario_name text not null,
  scenario_version integer not null,
  scenario_digest text not null,
  seed bigint not null,
  pins jsonb not null default '{}'::jsonb,
  metrics jsonb not null default '{}'::jsonb,
  evaluation jsonb not null default '{}'::jsonb,
  flags jsonb not null default '{}'::jsonb,
  status text not null,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists trials_experiment_idx on trials (experiment_id);

-- Experiments (experiment substrate design doc section 7): a
-- baseline-vs-candidate (or, with an empty candidates list, baseline-only
-- profile) comparison over a scenario selection. Recorded once at creation
-- (status e.g. "running"), then mutated in place to its terminal
-- status/result once the trial matrix's statistics pass completes.
--
-- CANONICAL DDL — mirrored by _EXPERIMENTS_DDL in
-- src/bakudo/registry/postgres_ledger.py, which self-migrates existing
-- databases (this file only runs at first initialization). Keep the two in
-- sync.
create table if not exists experiments (
  id text primary key,
  name text not null,
  spec jsonb not null,
  status text not null,
  result jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Integration-event outbox (section 17.1): durable handoff to projections.
create table if not exists outbox (
  id bigserial primary key,
  topic text not null,
  payload jsonb not null,
  published boolean not null default false,
  created_at timestamptz not null default now()
);
