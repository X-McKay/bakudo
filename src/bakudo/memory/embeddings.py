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
from typing import Any, Protocol

_TOKEN_RE = re.compile(r"[a-z0-9]+")


class Embedder(Protocol):
    @property
    def dim(self) -> int: ...

    def embed(self, text: str) -> list[float]: ...


class EmbeddingError(RuntimeError):
    """A real embedding call failed (HTTP error, bad shape, dimension drift).

    Raised instead of returning degenerate vectors: a silent zero vector would
    poison dedup and retrieval, so embedding failures must surface loudly.
    """


class OpenAIEmbedder:
    """Embeddings via an OpenAI-compatible ``/embeddings`` endpoint (vLLM).

    POSTs ``{"model": ..., "input": [...]}`` to ``{base_url}/embeddings``.
    The model dimension is probed on the first call, then pinned: every
    subsequent response must match or :class:`EmbeddingError` is raised
    (guards the typed ``vector(N)`` production column, MEM-4).

    ``httpx`` is imported lazily so core installs (no ``runtime`` extra)
    can import this module.
    """

    def __init__(
        self,
        base_url: str,
        model: str = "Qwen/Qwen3-Embedding-0.6B",
        api_key: str | None = None,
        timeout: float = 30.0,
        *,
        transport: Any | None = None,
    ) -> None:
        import httpx  # lazy: runtime extra only

        headers = {}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        self._base_url = base_url.rstrip("/")
        self._model = model
        self._client = httpx.Client(
            headers=headers, timeout=timeout, transport=transport
        )
        self._dim: int | None = None

    @property
    def dim(self) -> int:
        """The model's embedding dimension, probed on first use and pinned."""
        if self._dim is None:
            self.embed("dimension probe")
        assert self._dim is not None
        return self._dim

    def embed(self, text: str) -> list[float]:
        return self.embed_batch([text])[0]

    def embed_batch(self, texts: list[str]) -> list[list[float]]:
        """Embed a batch in one request, preserving input order."""
        if not texts:
            return []
        payload = self._post({"model": self._model, "input": list(texts)})
        vectors = self._vectors_from(payload, expected=len(texts))
        for vec in vectors:
            self._check_dim(vec)
        return vectors

    def close(self) -> None:
        self._client.close()

    # --- internals ---

    def _post(self, body: dict[str, Any]) -> dict[str, Any]:
        import httpx  # lazy

        url = f"{self._base_url}/embeddings"
        try:
            response = self._client.post(url, json=body)
        except httpx.HTTPError as exc:
            raise EmbeddingError(f"embeddings request to {url} failed: {exc}") from exc
        if response.status_code >= 400:
            raise EmbeddingError(
                f"embeddings endpoint {url} returned HTTP {response.status_code}: "
                f"{response.text[:200]}"
            )
        try:
            payload = response.json()
        except ValueError as exc:
            raise EmbeddingError(
                f"embeddings endpoint {url} returned non-JSON body"
            ) from exc
        if not isinstance(payload, dict):
            raise EmbeddingError(
                f"unexpected response shape from {url}: expected an object"
            )
        return payload

    @staticmethod
    def _vectors_from(
        payload: dict[str, Any], *, expected: int
    ) -> list[list[float]]:
        data = payload.get("data")
        if not isinstance(data, list):
            raise EmbeddingError(
                "unexpected response shape: missing 'data' list in embeddings reply"
            )
        by_index: dict[int, list[float]] = {}
        for entry in data:
            if not isinstance(entry, dict) or "embedding" not in entry:
                raise EmbeddingError(
                    "unexpected response shape: entry without 'embedding'"
                )
            vec = entry["embedding"]
            if not isinstance(vec, list) or not vec:
                raise EmbeddingError(
                    "unexpected response shape: 'embedding' is not a non-empty list"
                )
            by_index[int(entry.get("index", len(by_index)))] = [float(v) for v in vec]
        if len(by_index) != expected or set(by_index) != set(range(expected)):
            raise EmbeddingError(
                f"embeddings response returned {len(by_index)} vectors for "
                f"{expected} inputs"
            )
        return [by_index[i] for i in range(expected)]

    def _check_dim(self, vec: list[float]) -> None:
        if self._dim is None:
            self._dim = len(vec)
        elif len(vec) != self._dim:
            raise EmbeddingError(
                f"embedding dimension drift: pinned {self._dim}, got {len(vec)} — "
                "the endpoint's model changed under us"
            )


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
