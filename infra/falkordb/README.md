# FalkorDB — the relationship/graph memory (spec §14.2, §21)

FalkorDB is a Redis-module property graph queried with Cypher, so the graph
model from spec §21 (Run/Agent/Objective/Memory/Skill/File nodes and their
edges) carries over unchanged from the earlier Neo4j design. The compose file
runs `falkordb/falkordb:latest` on the standard Redis port (6379); the worker
wires the mirror from `FALKORDB_URL` (+ optional `FALKORDB_GRAPH`, default
`bakudo`).

Unlike Neo4j there is no init script to run before first use — nodes,
relationships, and their labels are created on first write
(`bakudo.memory.graph.FalkorGraphMemory.record_memory_edge`).

## Optional: constraints

FalkorDB enforces uniqueness via `GRAPH.CONSTRAINT CREATE` (each requires a
supporting exact-match index first). For the two node types written today:

```bash
redis-cli GRAPH.QUERY bakudo "CREATE INDEX FOR (r:Run) ON (r.id)"
redis-cli GRAPH.CONSTRAINT CREATE bakudo UNIQUE NODE Run PROPERTIES 1 id
redis-cli GRAPH.QUERY bakudo "CREATE INDEX FOR (m:Memory) ON (m.id)"
redis-cli GRAPH.CONSTRAINT CREATE bakudo UNIQUE NODE Memory PROPERTIES 1 id
```

## Optional: vector index over memory embeddings

`PgSemanticMemoryStore` mirrors each accepted memory's embedding onto the
`Memory` node (as a `vecf32` property). To retrieve graph-side by similarity,
create a vector index with dimensions matching the configured embedder (the
default `HashingEmbedder` emits **256**, not 1536):

```bash
redis-cli GRAPH.QUERY bakudo \
  "CREATE VECTOR INDEX FOR (m:Memory) ON (m.embedding) \
   OPTIONS {dimension: 256, similarityFunction: 'cosine'}"
```

Postgres/pgvector remains the authoritative semantic store; the FalkorDB
mirror exists for relationship-shaped queries (spec §21) as they get wired.
