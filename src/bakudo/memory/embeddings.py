"""Embeddings for semantic memory retrieval and dedup (spec section 14).

The :class:`Embedder` protocol lets production plug in a real model (vLLM/OpenAI
``embeddings``), while :class:`HashingEmbedder` provides a deterministic,
dependency-free fallback for tests and offline use. Vectors feed pgvector /
FalkorDB vector indexes in production.
"""

from __future__ import annotations

import hashlib
import math
import re
from typing import Protocol

_TOKEN_RE = re.compile(r"[a-z0-9]+")


class Embedder(Protocol):
    dim: int

    def embed(self, text: str) -> list[float]: ...


class HashingEmbedder:
    """A hashing bag-of-words embedder: deterministic and dependency-free.

    Not as expressive as a learned model, but it captures lexical overlap well
    enough for near-duplicate detection and coarse retrieval in tests/dev.
    """

    def __init__(self, dim: int = 256) -> None:
        self.dim = dim

    def embed(self, text: str) -> list[float]:
        vec = [0.0] * self.dim
        for token in _TOKEN_RE.findall(text.lower()):
            h = int(hashlib.sha1(token.encode()).hexdigest(), 16)
            vec[h % self.dim] += 1.0
        return _l2_normalize(vec)


def _l2_normalize(vec: list[float]) -> list[float]:
    norm = math.sqrt(sum(v * v for v in vec))
    if norm == 0.0:
        return vec
    return [v / norm for v in vec]


def cosine(a: list[float], b: list[float]) -> float:
    """Cosine similarity of two (assumed L2-normalised) vectors."""
    return sum(x * y for x, y in zip(a, b, strict=True))
