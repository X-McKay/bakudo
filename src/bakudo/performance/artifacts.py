"""Content-addressed storage contracts for bounded performance artifacts.

The performance ledger stores :class:`ArtifactRef` metadata, while large raw
profiles and sample attachments live behind this small replaceable port.  The
in-memory adapter is intentionally deterministic and is suitable for contract
tests; production object storage can implement the same protocol later.
"""

from __future__ import annotations

import hashlib
import os
import re
from dataclasses import dataclass
from pathlib import Path
from tempfile import NamedTemporaryFile
from typing import Protocol
from urllib.parse import unquote, urlparse

DEFAULT_MAX_ARTIFACT_BYTES = 64 * 1024 * 1024


class ArtifactStoreError(RuntimeError):
    """Base class for artifact-store failures."""


class ArtifactTooLargeError(ArtifactStoreError):
    """Raised when an artifact exceeds the configured hard byte limit."""


class ArtifactNotFoundError(ArtifactStoreError):
    """Raised when an artifact reference is absent from the store."""


class ArtifactIntegrityError(ArtifactStoreError):
    """Raised when stored bytes do not match reference metadata."""


@dataclass(frozen=True)
class ArtifactInput:
    """Bytes and bounded metadata supplied to an :class:`ArtifactStore`."""

    content: bytes
    media_type: str
    visibility: str = "private"
    retention_class: str = "default"

    def __post_init__(self) -> None:
        if not isinstance(self.content, bytes):
            raise TypeError("artifact content must be bytes")
        if not self.media_type.strip():
            raise ValueError("artifact media_type must not be empty")
        if not self.visibility.strip():
            raise ValueError("artifact visibility must not be empty")
        if not self.retention_class.strip():
            raise ValueError("artifact retention_class must not be empty")


@dataclass(frozen=True)
class ArtifactRef:
    """Immutable metadata identifying content stored by digest."""

    uri: str
    digest: str
    media_type: str
    size_bytes: int
    visibility: str = "private"
    retention_class: str = "default"

    def __post_init__(self) -> None:
        if not self.uri.strip():
            raise ValueError("artifact uri must not be empty")
        if re.fullmatch(r"sha256:[0-9a-f]{64}", self.digest) is None:
            raise ValueError("artifact digest must be a sha256 digest")
        if not self.media_type.strip():
            raise ValueError("artifact media_type must not be empty")
        if self.size_bytes < 0:
            raise ValueError("artifact size_bytes must not be negative")
        if not self.visibility.strip():
            raise ValueError("artifact visibility must not be empty")
        if not self.retention_class.strip():
            raise ValueError("artifact retention_class must not be empty")


class ArtifactStore(Protocol):
    """Replaceable content-addressed byte store."""

    def put(self, artifact: ArtifactInput) -> ArtifactRef:
        """Store ``artifact`` idempotently and return its immutable reference."""
        ...

    def get(self, ref: ArtifactRef) -> bytes:
        """Return bytes after verifying them against ``ref``."""
        ...


class InMemoryArtifactStore:
    """Deterministic content-addressed store for tests and local composition."""

    def __init__(self, *, max_artifact_bytes: int = DEFAULT_MAX_ARTIFACT_BYTES) -> None:
        if max_artifact_bytes < 1:
            raise ValueError("max_artifact_bytes must be at least 1")
        self._max_artifact_bytes = max_artifact_bytes
        self._content: dict[str, bytes] = {}

    def put(self, artifact: ArtifactInput) -> ArtifactRef:
        size_bytes = len(artifact.content)
        if size_bytes > self._max_artifact_bytes:
            raise ArtifactTooLargeError(
                f"artifact is {size_bytes} bytes; limit is {self._max_artifact_bytes} bytes"
            )

        content = bytes(artifact.content)
        digest = f"sha256:{hashlib.sha256(content).hexdigest()}"
        self._content.setdefault(digest, content)
        return ArtifactRef(
            uri=f"memory://artifacts/{digest}",
            digest=digest,
            media_type=artifact.media_type,
            size_bytes=size_bytes,
            visibility=artifact.visibility,
            retention_class=artifact.retention_class,
        )

    def get(self, ref: ArtifactRef) -> bytes:
        expected_uri = f"memory://artifacts/{ref.digest}"
        if ref.uri != expected_uri:
            raise ArtifactIntegrityError(
                f"artifact URI does not match digest: {ref.uri!r} != {expected_uri!r}"
            )
        try:
            content = self._content[ref.digest]
        except KeyError as exc:
            raise ArtifactNotFoundError(f"artifact not found: {ref.digest}") from exc

        actual_digest = f"sha256:{hashlib.sha256(content).hexdigest()}"
        if actual_digest != ref.digest or len(content) != ref.size_bytes:
            raise ArtifactIntegrityError(f"artifact integrity check failed: {ref.digest}")
        return bytes(content)

    def __len__(self) -> int:
        """Return the number of unique stored byte payloads."""

        return len(self._content)


class DirectoryArtifactStore:
    """Local, content-addressed artifact adapter with atomic immutable writes."""

    def __init__(
        self,
        root: Path,
        *,
        max_artifact_bytes: int = DEFAULT_MAX_ARTIFACT_BYTES,
    ) -> None:
        if max_artifact_bytes < 1:
            raise ValueError("max_artifact_bytes must be at least 1")
        self.root = root.expanduser().resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self._max_artifact_bytes = max_artifact_bytes

    def _path(self, digest: str) -> Path:
        if re.fullmatch(r"sha256:[0-9a-f]{64}", digest) is None:
            raise ArtifactIntegrityError("artifact digest must be a sha256 digest")
        hexadecimal = digest.removeprefix("sha256:")
        return self.root / hexadecimal[:2] / hexadecimal[2:]

    @staticmethod
    def _digest(content: bytes) -> str:
        return f"sha256:{hashlib.sha256(content).hexdigest()}"

    def put(self, artifact: ArtifactInput) -> ArtifactRef:
        content = bytes(artifact.content)
        if len(content) > self._max_artifact_bytes:
            raise ArtifactTooLargeError(
                f"artifact is {len(content)} bytes; limit is {self._max_artifact_bytes} bytes"
            )
        digest = self._digest(content)
        destination = self._path(digest)
        destination.parent.mkdir(parents=True, exist_ok=True)
        if destination.exists():
            if destination.is_symlink() or destination.read_bytes() != content:
                raise ArtifactIntegrityError(f"artifact collision at {destination}")
        else:
            temporary: Path | None = None
            try:
                with NamedTemporaryFile(dir=destination.parent, delete=False) as stream:
                    stream.write(content)
                    stream.flush()
                    os.fsync(stream.fileno())
                    temporary = Path(stream.name)
                temporary.chmod(0o440)
                os.replace(temporary, destination)
            finally:
                if temporary is not None:
                    temporary.unlink(missing_ok=True)
        return ArtifactRef(
            uri=destination.as_uri(),
            digest=digest,
            media_type=artifact.media_type,
            size_bytes=len(content),
            visibility=artifact.visibility,
            retention_class=artifact.retention_class,
        )

    def get(self, ref: ArtifactRef) -> bytes:
        parsed = urlparse(ref.uri)
        if parsed.scheme != "file":
            raise ArtifactIntegrityError("directory artifact URI must use file://")
        path = Path(unquote(parsed.path)).resolve()
        expected = self._path(ref.digest)
        if path != expected:
            raise ArtifactIntegrityError("artifact URI does not match its digest path")
        try:
            metadata = path.lstat()
            if path.is_symlink() or not path.is_file():
                raise ArtifactIntegrityError("artifact must be a regular non-symlink file")
            if metadata.st_size > self._max_artifact_bytes:
                raise ArtifactTooLargeError(
                    f"artifact is {metadata.st_size} bytes; "
                    f"limit is {self._max_artifact_bytes} bytes"
                )
            content = path.read_bytes()
        except FileNotFoundError as exc:
            raise ArtifactNotFoundError(f"artifact not found: {ref.digest}") from exc
        if len(content) != ref.size_bytes or self._digest(content) != ref.digest:
            raise ArtifactIntegrityError(f"artifact integrity check failed: {ref.digest}")
        return content
