"""Neo4j relationship/graph memory adapter (spec sections 14.2, 21).

``neo4j`` is imported lazily. This adapter mirrors memory writes into the
graph (the one edge the durable store consumes today). The richer run/skill
graph queries the spec describes (§14.2) are deliberately not implemented
until something reads them — see the "not yet" list in the README.
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

    def record_memory_edge(
        self,
        run_id: str,
        memory: MemoryItem,
        embedding: list[float] | None = None,
    ) -> None:
        """Mirror a memory write into the graph.

        When ``embedding`` is provided it is stored on the ``Memory`` node,
        which is what the optional vector index in ``infra/neo4j/init.cypher``
        indexes for graph-side semantic retrieval.
        """
        cypher = """
        merge (r:Run {id: $run_id})
        merge (m:Memory {id: $mem_id})
          set m.type = $type, m.confidence = $confidence
        foreach (_ in case when $embedding is null then [] else [1] end |
          set m.embedding = $embedding)
        merge (r)-[:PRODUCED_MEMORY]->(m)
        """
        with self._driver.session() as session:
            session.run(
                cypher, run_id=run_id, mem_id=memory.id,
                type=memory.type, confidence=memory.confidence,
                embedding=embedding,
            )
