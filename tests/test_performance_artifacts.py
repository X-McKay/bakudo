from __future__ import annotations

from dataclasses import replace

import pytest

from bakudo.performance.artifacts import (
    ArtifactInput,
    ArtifactIntegrityError,
    ArtifactNotFoundError,
    ArtifactRef,
    ArtifactTooLargeError,
    DirectoryArtifactStore,
    InMemoryArtifactStore,
)


def test_put_is_content_addressed_and_get_returns_copy() -> None:
    store = InMemoryArtifactStore()
    artifact = ArtifactInput(content=b"profile", media_type="application/octet-stream")

    ref = store.put(artifact)

    assert ref.digest.startswith("sha256:")
    assert ref.uri == f"memory://artifacts/{ref.digest}"
    assert ref.size_bytes == 7
    assert store.get(ref) == b"profile"


def test_duplicate_put_is_idempotent() -> None:
    store = InMemoryArtifactStore()
    artifact = ArtifactInput(content=b"same", media_type="text/plain")

    first = store.put(artifact)
    second = store.put(artifact)

    assert first == second
    assert len(store) == 1


def test_metadata_can_differ_without_duplicating_content() -> None:
    store = InMemoryArtifactStore()

    private = store.put(ArtifactInput(content=b"same", media_type="text/plain"))
    restricted = store.put(
        ArtifactInput(
            content=b"same",
            media_type="application/octet-stream",
            visibility="restricted",
            retention_class="short",
        )
    )

    assert private.digest == restricted.digest
    assert private.media_type != restricted.media_type
    assert len(store) == 1


def test_put_enforces_size_bound() -> None:
    store = InMemoryArtifactStore(max_artifact_bytes=3)

    with pytest.raises(ArtifactTooLargeError, match="4 bytes; limit is 3"):
        store.put(ArtifactInput(content=b"four", media_type="text/plain"))


def test_get_rejects_missing_and_inconsistent_references() -> None:
    store = InMemoryArtifactStore()
    ref = store.put(ArtifactInput(content=b"profile", media_type="text/plain"))
    missing = ArtifactRef(
        uri="memory://artifacts/sha256:" + "0" * 64,
        digest="sha256:" + "0" * 64,
        media_type="text/plain",
        size_bytes=1,
    )

    with pytest.raises(ArtifactNotFoundError):
        store.get(missing)
    with pytest.raises(ArtifactIntegrityError):
        store.get(replace(ref, size_bytes=ref.size_bytes + 1))
    with pytest.raises(ArtifactIntegrityError):
        store.get(replace(ref, uri="memory://artifacts/wrong"))


def test_artifact_ref_validates_content_address_metadata() -> None:
    with pytest.raises(ValueError, match="sha256 digest"):
        ArtifactRef(uri="memory://artifact", digest="bad", media_type="text/plain", size_bytes=1)
    with pytest.raises(ValueError, match="size_bytes"):
        ArtifactRef(
            uri="memory://artifact",
            digest="sha256:" + "0" * 64,
            media_type="text/plain",
            size_bytes=-1,
        )


def test_directory_store_round_trip_is_content_addressed_and_idempotent(tmp_path) -> None:
    store = DirectoryArtifactStore(tmp_path / "artifacts")
    artifact = ArtifactInput(b"profile bytes", "application/octet-stream")

    first = store.put(artifact)
    second = store.put(artifact)

    assert first == second
    assert first.uri.startswith("file://")
    assert store.get(first) == b"profile bytes"


def test_directory_store_rejects_uri_not_derived_from_digest(tmp_path) -> None:
    store = DirectoryArtifactStore(tmp_path / "artifacts")
    ref = store.put(ArtifactInput(b"profile bytes", "application/octet-stream"))
    forged = ArtifactRef(
        uri=(tmp_path / "elsewhere").as_uri(),
        digest=ref.digest,
        media_type=ref.media_type,
        size_bytes=ref.size_bytes,
    )

    with pytest.raises(ArtifactIntegrityError, match="URI does not match"):
        store.get(forged)


@pytest.mark.parametrize("field", ["media_type", "visibility", "retention_class"])
def test_artifact_metadata_must_not_be_empty(field: str) -> None:
    values = {
        "content": b"x",
        "media_type": "text/plain",
        "visibility": "private",
        "retention_class": "default",
    }
    values[field] = " "

    with pytest.raises(ValueError):
        ArtifactInput(**values)
