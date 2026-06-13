// bakudo relationship/graph memory schema (spec sections 14.2 and 21).
// Run with: cypher-shell -f infra/neo4j/init.cypher

// Uniqueness constraints (these implicitly create lookup indexes).
create constraint agent_name if not exists
  for (a:Agent) require a.name is unique;

create constraint run_id if not exists
  for (r:Run) require r.id is unique;

create constraint objective_id if not exists
  for (o:Objective) require o.id is unique;

create constraint skill_name if not exists
  for (s:Skill) require s.name is unique;

create constraint memory_id if not exists
  for (m:Memory) require m.id is unique;

create constraint failure_mode_name if not exists
  for (f:FailureMode) require f.name is unique;

// A composite key for AgentVersion and File.
create constraint agent_version_key if not exists
  for (av:AgentVersion) require (av.name, av.version) is unique;

create constraint file_key if not exists
  for (f:File) require (f.repo, f.path) is unique;

// Optional: a vector index over memory embeddings for semantic retrieval.
// create vector index memory_embeddings if not exists
//   for (m:Memory) on (m.embedding)
//   options { indexConfig: { `vector.dimensions`: 1536, `vector.similarity_function`: 'cosine' } };
