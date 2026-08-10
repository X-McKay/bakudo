"""FalkorDB relationship/graph memory adapter (spec sections 14.2, 21).

``falkordb`` is imported lazily. This adapter writes the relationship edges
that are painful to model relationally, and exposes the two highest-value
queries from the spec: skills that help with a failure mode, and prior runs
that touched overlapping files.

FalkorDB replaces the frozen Neo4j mirror (issue #29). Differences from the
Neo4j dialect this adapter absorbs:

* Constraints are not Cypher DDL — they are ``GRAPH.CONSTRAINT`` commands,
  issued here via the client's ``create_node_unique_constraint`` (which also
  creates the required supporting range indexes).
* Vector indexes only cover ``vecf32``-typed properties, so embeddings are
  stored with ``vecf32($embedding)``; the index dimension is parameterized
  from the wired embedder instead of the old hardcoded 1536 (MEM-16).
* There is no ``FOREACH (...| SET ...)`` conditional-set idiom; the upsert
  query is built with or without the embedding assignment instead.
* Namespacing (MEM-16): FalkorDB keys each graph by name inside one Redis
  instance, so every ``group_id`` gets its own graph key
  (``bakudo-memory:<group_id>``) rather than sharing one global graph.
"""

from __future__ import annotations

from typing import Any

from .models import MemoryItem

GRAPH_NAME_PREFIX = "bakudo-memory"

# Uniqueness constraints ported from the retired infra/neo4j/init.cypher
# (single-property keys plus the AgentVersion/File composite keys).
_UNIQUE_CONSTRAINTS: list[tuple[str, tuple[str, ...]]] = [
    ("Agent", ("name",)),
    ("Run", ("id",)),
    ("Objective", ("id",)),
    ("Skill", ("name",)),
    ("Memory", ("id",)),
    ("FailureMode", ("name",)),
    ("AgentVersion", ("name", "version")),
    ("File", ("repo", "path")),
]

# FalkorDB errors on re-creating existing schema objects; these substrings
# mark the benign "already there" family so ensure_schema stays idempotent.
_ALREADY_EXISTS_MARKERS = ("already exists", "already indexed")


def graph_name_for(group_id: str) -> str:
    """The per-group graph key on the shared FalkorDB instance (MEM-16)."""
    return f"{GRAPH_NAME_PREFIX}:{group_id}"


def _is_already_exists(exc: Exception) -> bool:
    message = str(exc).lower()
    return any(marker in message for marker in _ALREADY_EXISTS_MARKERS)


class FalkorGraphMemory:
    """A thin wrapper over a falkordb ``Graph`` (one graph key per group)."""

    def __init__(self, graph: Any, *, db: Any | None = None) -> None:
        self._graph = graph
        self._db = db

    @classmethod
    def connect(cls, url: str, *, group_id: str = "default") -> FalkorGraphMemory:
        """Connect to FalkorDB (``falkor://`` / ``redis://`` URL; credentials
        ride in the URL) and select the group's graph key."""
        from falkordb import FalkorDB  # lazy

        db = FalkorDB.from_url(url)
        return cls(db.select_graph(graph_name_for(group_id)), db=db)

    def close(self) -> None:
        if self._db is not None:
            self._db.close()

    # --- schema ---

    def ensure_schema(self, *, vector_dim: int | None = None) -> None:
        """Create the uniqueness constraints (and their supporting indexes),
        plus the Memory-embedding vector index when ``vector_dim`` is given.

        The dimension comes from the wired embedder at boot, never a
        hardcoded constant (MEM-16). Safe to call on every worker start:
        "already exists/indexed" responses are swallowed.
        """
        for label, properties in _UNIQUE_CONSTRAINTS:
            try:
                self._graph.create_node_unique_constraint(label, *properties)
            except Exception as exc:
                if not _is_already_exists(exc):
                    raise
        if vector_dim is not None:
            try:
                self._graph.create_node_vector_index(
                    "Memory", "embedding", dim=vector_dim, similarity_function="cosine"
                )
            except Exception as exc:
                if not _is_already_exists(exc):
                    raise

    # --- writes ---

    def record_run_edges(
        self,
        run_id: str,
        agent_name: str,
        agent_version: int,
        objective_id: str,
        touched_files: list[str],
        repo: str,
    ) -> None:
        """Create (:Run)-[:USED_AGENT]->, -[:ATTEMPTED]->, -[:TOUCHED_FILE]-> edges."""
        cypher = """
        merge (r:Run {id: $run_id})
        merge (av:AgentVersion {name: $agent_name, version: $agent_version})
        merge (o:Objective {id: $objective_id})
        merge (r)-[:USED_AGENT]->(av)
        merge (r)-[:ATTEMPTED]->(o)
        with r
        unwind $files as path
          merge (f:File {repo: $repo, path: path})
          merge (r)-[:TOUCHED_FILE]->(f)
        """
        self._graph.query(
            cypher,
            params={
                "run_id": run_id,
                "agent_name": agent_name,
                "agent_version": agent_version,
                "objective_id": objective_id,
                "files": touched_files,
                "repo": repo,
            },
        )

    def record_memory_edge(
        self,
        run_id: str,
        memory: MemoryItem,
        embedding: list[float] | None = None,
    ) -> None:
        """Mirror a memory write into the graph (see :meth:`upsert_memory`)."""
        self.upsert_memory(
            run_id=run_id,
            memory_id=memory.id,
            memory_type=memory.type,
            confidence=memory.confidence,
            embedding=embedding,
        )

    def upsert_memory(
        self,
        *,
        run_id: str,
        memory_id: str,
        memory_type: str,
        confidence: float,
        embedding: list[float] | None = None,
    ) -> None:
        """Merge the ``(:Run)-[:PRODUCED_MEMORY]->(:Memory)`` mirror edge.

        Idempotent (pure MERGE/SET), so outbox retries are safe. When
        ``embedding`` is provided it is stored as ``vecf32`` — the only
        property type FalkorDB vector indexes cover.
        """
        set_clauses = ["m.type = $type", "m.confidence = $confidence"]
        params: dict[str, Any] = {
            "run_id": run_id,
            "mem_id": memory_id,
            "type": memory_type,
            "confidence": confidence,
        }
        if embedding is not None:
            set_clauses.append("m.embedding = vecf32($embedding)")
            params["embedding"] = [float(v) for v in embedding]
        cypher = (
            "merge (r:Run {id: $run_id})\n"
            "merge (m:Memory {id: $mem_id})\n"
            f"set {', '.join(set_clauses)}\n"
            "merge (r)-[:PRODUCED_MEMORY]->(m)"
        )
        self._graph.query(cypher, params=params)

    def remove_memory(self, memory_id: str) -> None:
        """Delete a mirrored Memory node (and its edges).

        Called when Postgres supersedes a memory, so the graph never
        accumulates nodes the relational store already deleted (MEM-10).
        Idempotent: deleting an absent node matches nothing.
        """
        self._graph.query(
            "match (m:Memory {id: $mem_id}) detach delete m",
            params={"mem_id": memory_id},
        )

    # --- queries ---

    def skills_for_failure_mode(self, failure_mode: str, limit: int = 10) -> list[str]:
        cypher = (
            "match (s:Skill)-[:HELPS_WITH]->(f:FailureMode {name: $failure_mode})\n"
            f"return s.name as name limit {int(limit)}"
        )
        result = self._graph.query(cypher, params={"failure_mode": failure_mode})
        return [row[0] for row in result.result_set]

    def runs_touching_files(self, paths: list[str], limit: int = 20) -> list[dict[str, Any]]:
        cypher = (
            "match (r:Run)-[:TOUCHED_FILE]->(f:File)\n"
            "where f.path in $paths\n"
            "return r.id as run_id, count(f) as overlap\n"
            f"order by overlap desc limit {int(limit)}"
        )
        result = self._graph.query(cypher, params={"paths": paths})
        return [{"run_id": row[0], "overlap": row[1]} for row in result.result_set]
