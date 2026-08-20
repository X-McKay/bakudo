"""OpenAIEmbedder against a mocked httpx transport (MEM-1).

The embedder is the production counterpart of HashingEmbedder: it POSTs
OpenAI-format ``{model, input}`` requests to ``{base_url}/embeddings``,
probes and pins the model dimension, and fails loudly (typed error) on any
HTTP or shape problem — never silent zero vectors.
"""

from __future__ import annotations

import json
import os

import httpx
import pytest

from bakudo.memory.embeddings import EmbeddingError, OpenAIEmbedder


def make_transport(handler) -> httpx.MockTransport:
    return httpx.MockTransport(handler)


def embedding_response(vectors: list[list[float]], *, shuffle: bool = False) -> httpx.Response:
    data = [{"object": "embedding", "index": i, "embedding": vec} for i, vec in enumerate(vectors)]
    if shuffle:
        data = list(reversed(data))
    return httpx.Response(200, json={"object": "list", "data": data})


def make_embedder(handler, **kwargs) -> OpenAIEmbedder:
    return OpenAIEmbedder("http://embed.test/v1", transport=make_transport(handler), **kwargs)


def test_embed_posts_openai_format_and_returns_vector() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return embedding_response([[1.0, 2.0, 3.0]])

    emb = make_embedder(handler)
    vec = emb.embed("hello world")

    assert vec == [1.0, 2.0, 3.0]
    request = seen[0]
    assert str(request.url) == "http://embed.test/v1/embeddings"
    body = json.loads(request.content)
    assert body == {"model": "Qwen/Qwen3-Embedding-0.6B", "input": ["hello world"]}


def test_dim_is_probed_once_and_cached() -> None:
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        n = len(json.loads(request.content)["input"])
        return embedding_response([[0.1, 0.2, 0.3, 0.4]] * n)

    emb = make_embedder(handler)
    assert emb.dim == 4
    assert emb.dim == 4  # cached: no second probe
    assert calls == 1


def test_dim_mismatch_in_later_response_raises() -> None:
    responses = [[[1.0, 2.0, 3.0]], [[1.0, 2.0]]]

    def handler(request: httpx.Request) -> httpx.Response:
        return embedding_response(responses.pop(0))

    emb = make_embedder(handler)
    assert emb.embed("first") == [1.0, 2.0, 3.0]
    with pytest.raises(EmbeddingError, match="dimension"):
        emb.embed("second")


def test_embed_batch_preserves_input_order_despite_index_shuffle() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        texts = json.loads(request.content)["input"]
        vectors = [[float(i), float(i)] for i in range(len(texts))]
        return embedding_response(vectors, shuffle=True)

    emb = make_embedder(handler)
    got = emb.embed_batch(["a", "b", "c"])
    assert got == [[0.0, 0.0], [1.0, 1.0], [2.0, 2.0]]


def test_embed_batch_empty_is_noop() -> None:
    def handler(request: httpx.Request) -> httpx.Response:  # pragma: no cover
        raise AssertionError("no request expected for an empty batch")

    emb = make_embedder(handler)
    assert emb.embed_batch([]) == []


def test_api_key_sent_as_bearer_and_custom_model() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return embedding_response([[1.0]])

    emb = make_embedder(handler, model="other-model", api_key="sk-test-abc")
    emb.embed("x")

    request = seen[0]
    assert request.headers["Authorization"] == "Bearer sk-test-abc"
    assert json.loads(request.content)["model"] == "other-model"


def test_http_error_raises_typed_error_with_status() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(503, text="upstream down")

    emb = make_embedder(handler)
    with pytest.raises(EmbeddingError, match="503"):
        emb.embed("x")


def test_malformed_response_shape_raises() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"unexpected": True})

    emb = make_embedder(handler)
    with pytest.raises(EmbeddingError, match="shape"):
        emb.embed("x")


def test_wrong_vector_count_raises() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return embedding_response([[1.0, 2.0]])  # one vector for two inputs

    emb = make_embedder(handler)
    with pytest.raises(EmbeddingError, match="2 inputs"):
        emb.embed_batch(["a", "b"])


def test_base_url_trailing_slash_normalised() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return embedding_response([[1.0]])

    emb = OpenAIEmbedder("http://embed.test/v1/", transport=make_transport(handler))
    emb.embed("x")
    assert str(seen[0].url) == "http://embed.test/v1/embeddings"


@pytest.mark.live
@pytest.mark.skipif(
    not os.environ.get("VLLM_EMBED_URL"),
    reason="VLLM_EMBED_URL not set; live embeddings probe skipped",
)
def test_live_qwen3_embedding_dimension_is_1024() -> None:
    """The production schema types memory_embeddings as vector(1024) (MEM-4);
    this probe pins the live Qwen3-Embedding-0.6B endpoint to that dimension."""
    emb = OpenAIEmbedder(os.environ["VLLM_EMBED_URL"], api_key=os.environ.get("VLLM_API_KEY"))
    assert emb.dim == 1024
