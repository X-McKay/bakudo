"""Memory architecture: evidence-backed, policy-gated memory (spec section 14)."""

from .embeddings import Embedder, HashingEmbedder, cosine
from .models import Evidence, MemoryItem, MemoryType
from .policy import MemoryRejected, validate_memory_candidate
from .semantic import SemanticMemoryStore
from .store import InMemoryStore, MemoryStore
from .store_pg import PgSemanticMemoryStore

__all__ = [
    "Evidence",
    "MemoryItem",
    "MemoryType",
    "MemoryRejected",
    "validate_memory_candidate",
    "MemoryStore",
    "InMemoryStore",
    "SemanticMemoryStore",
    "PgSemanticMemoryStore",
    "Embedder",
    "HashingEmbedder",
    "cosine",
]
