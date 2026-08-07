"""FalkorDB relationship/graph memory adapter (spec sections 14.2, 21).

FalkorDB is a Redis-module property graph queried with Cypher, so the graph
model from spec §21 carries over unchanged. The ``falkordb`` client is
imported lazily. This adapter mirrors memory writes into the graph (the one
edge the durable store consumes today). The richer run/skill graph queries
the spec describes (§14.2) are deliberately not implemented until something
reads them — see the "not yet" list in the README.
"""

from __future__ import annotations

from typing import Any

from .models import MemoryItem

DEFAULT_GRAPH_NAME = "bakudo"


class FalkorGraphMemory:
    """A thin wrapper over one FalkorDB graph."""

    def __init__(self, db: Any, graph: Any) -> None:
        self._db = db
        self._graph = graph

    @classmethod
    def connect(
        cls, url: str, *, graph_name: str = DEFAULT_GRAPH_NAME
    ) -> FalkorGraphMemory:
        """Connect via a redis:// / falkor:// URL and select the graph."""
        from falkordb import FalkorDB  # lazy

        db = FalkorDB.from_url(url)
        return cls(db, db.select_graph(graph_name))

    def close(self) -> None:
        # The FalkorDB client rides on a redis connection; close that.
        connection = getattr(self._db, "connection", None)
        if connection is not None:
            connection.close()

    def record_memory_edge(
        self,
        run_id: str,
        memory: MemoryItem,
        embedding: list[float] | None = None,
    ) -> None:
        """Mirror a memory write into the graph.

        When ``embedding`` is provided it is stored on the ``Memory`` node
        (see ``infra/falkordb/README.md`` for the optional vector index).
        FalkorDB has no FOREACH-based conditional SET, so the embedding
        variant is a separate query.
        """
        params = {
            "run_id": run_id,
            "mem_id": memory.id,
            "type": memory.type,
            "confidence": memory.confidence,
        }
        cypher = (
            "merge (r:Run {id: $run_id}) "
            "merge (m:Memory {id: $mem_id}) "
            "set m.type = $type, m.confidence = $confidence "
        )
        if embedding is not None:
            cypher += ", m.embedding = vecf32($embedding) "
            params["embedding"] = embedding
        cypher += "merge (r)-[:PRODUCED_MEMORY]->(m)"
        self._graph.query(cypher, params)
