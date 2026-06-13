"""Neo4j relationship/graph memory adapter (spec sections 14.2, 21).

``neo4j`` is imported lazily. This adapter writes the relationship edges that
are painful to model relationally, and exposes the two highest-value queries
from the spec: skills that help with a failure mode, and prior runs that
touched overlapping files.
"""

from __future__ import annotations

from typing import Any

from .models import MemoryItem


class Neo4jGraphMemory:
    """A thin wrapper over a neo4j async driver session factory."""

    def __init__(self, driver: Any) -> None:
        self._driver = driver

    @classmethod
    def connect(cls, uri: str, user: str, password: str) -> Neo4jGraphMemory:
        from neo4j import GraphDatabase  # lazy

        return cls(GraphDatabase.driver(uri, auth=(user, password)))

    def close(self) -> None:
        self._driver.close()

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
        with self._driver.session() as session:
            session.run(
                cypher,
                run_id=run_id, agent_name=agent_name, agent_version=agent_version,
                objective_id=objective_id, files=touched_files, repo=repo,
            )

    def record_memory_edge(self, run_id: str, memory: MemoryItem) -> None:
        cypher = """
        merge (r:Run {id: $run_id})
        merge (m:Memory {id: $mem_id})
          set m.type = $type, m.confidence = $confidence
        merge (r)-[:PRODUCED_MEMORY]->(m)
        """
        with self._driver.session() as session:
            session.run(
                cypher, run_id=run_id, mem_id=memory.id,
                type=memory.type, confidence=memory.confidence,
            )

    def skills_for_failure_mode(self, failure_mode: str, limit: int = 10) -> list[str]:
        cypher = """
        match (s:Skill)-[:HELPS_WITH]->(f:FailureMode {name: $failure_mode})
        return s.name as name limit $limit
        """
        with self._driver.session() as session:
            result = session.run(cypher, failure_mode=failure_mode, limit=limit)
            return [rec["name"] for rec in result]

    def runs_touching_files(self, paths: list[str], limit: int = 20) -> list[dict[str, Any]]:
        cypher = """
        match (r:Run)-[:TOUCHED_FILE]->(f:File)
        where f.path in $paths
        return r.id as run_id, count(f) as overlap
        order by overlap desc limit $limit
        """
        with self._driver.session() as session:
            return [dict(rec) for rec in session.run(cypher, paths=paths, limit=limit)]
