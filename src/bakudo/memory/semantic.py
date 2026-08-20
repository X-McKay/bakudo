"""Semantic memory store: similarity-based retrieval and dedup (spec section 14).

Upgrades the exact-string dedup of :class:`InMemoryStore` to embedding cosine
similarity, and retrieves by semantic closeness to a query. The write policy
(evidence, scope, secrets) still applies first — unverified memories never
become facts.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from .embeddings import Embedder, HashingEmbedder, cosine
from .models import MemoryItem
from .policy import MemoryRejected, validate_memory_candidate

# Above this cosine similarity a candidate is considered a near-duplicate.
DEFAULT_DEDUP_THRESHOLD = 0.95


@dataclass
class _Entry:
    item: MemoryItem
    embedding: list[float]


@dataclass
class SemanticMemoryStore:
    embedder: Embedder = field(default_factory=HashingEmbedder)
    dedup_threshold: float = DEFAULT_DEDUP_THRESHOLD
    _entries: list[_Entry] = field(default_factory=list, init=False)

    def write_candidate(self, item: MemoryItem) -> MemoryItem:
        existing = [e.item for e in self._entries]
        reasons = validate_memory_candidate(item, existing)
        if reasons:
            raise MemoryRejected("; ".join(reasons))

        embedding = self.embedder.embed(item.content)
        # Consider the NEAREST existing memory (highest cosine), matching the
        # durable Pg store's `_nearest` dedup (MEM-20). Superseding an
        # arbitrary insertion-order match — as this did — made the in-memory
        # and Postgres stores disagree on *which* memory a near-duplicate
        # replaces; the nearest is the well-defined, store-agnostic choice.
        nearest: _Entry | None = None
        best = -1.0
        for entry in self._entries:
            sim = cosine(embedding, entry.embedding)
            if sim > best:
                best, nearest = sim, entry

        if nearest is not None and best >= self.dedup_threshold:
            # A near-duplicate already exists; reject unless this one is
            # strictly more confident (in which case it supersedes).
            if nearest.item.confidence >= item.confidence:
                raise MemoryRejected("near-duplicate of an equally/more confident memory")
            nearest.item, nearest.embedding = item, embedding
            return item

        self._entries.append(_Entry(item, embedding))
        return item

    def query(
        self,
        *,
        text: str | None = None,
        scope: dict | None = None,
        limit: int = 10,
        min_similarity: float = 0.0,
    ) -> list[MemoryItem]:
        candidates = self._entries
        if scope:
            candidates = [
                e for e in candidates if all(e.item.scope.get(k) == v for k, v in scope.items())
            ]
        if text is None:
            return [
                e.item for e in sorted(candidates, key=lambda e: e.item.confidence, reverse=True)
            ][:limit]

        q = self.embedder.embed(text)
        scored = [(cosine(q, e.embedding), e.item) for e in candidates]
        scored = [(s, item) for s, item in scored if s >= min_similarity]
        scored.sort(key=lambda pair: pair[0], reverse=True)
        return [item for _, item in scored[:limit]]

    def all(self) -> list[MemoryItem]:
        return [e.item for e in self._entries]
