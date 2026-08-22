"""Input validation and atomic output publication for product-agent v1."""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import stat
import subprocess
import tempfile
import tomllib
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

from ..paths import abox_templates_dir
from .contracts import PATCH_FILENAME, ProductAgentResult

MAX_INSTRUCTION_BYTES = 2 * 1024 * 1024
MAX_TRACKED_FILES = 20_000
MAX_TRACKED_BYTES = 512 * 1024 * 1024
MAX_PATH_BYTES = 4096

_COMPATIBILITY_ABOX_FILES = ("project.toml", "prepare.sh")
_RESERVED_PREFIXES = (".agent",)


class ProductAgentInputError(ValueError):
    """A caller-controlled path or workspace failed the v1 preflight."""


@dataclass(frozen=True, slots=True)
class ValidatedInput:
    workspace: Path
    instruction: str
    output_dir: Path
    base_commit: str


def sha256_bytes(content: bytes) -> str:
    return f"sha256:{hashlib.sha256(content).hexdigest()}"


def _absolute(value: str | Path, *, field: str, must_exist: bool) -> Path:
    path = Path(value)
    _validate_host_path(path, field=field)
    if not path.is_absolute():
        raise ProductAgentInputError(f"{field} must be an absolute path")
    if path.is_symlink():
        raise ProductAgentInputError(f"{field} must not be a symbolic link")
    try:
        resolved = path.resolve(strict=must_exist)
    except OSError as exc:
        raise ProductAgentInputError(f"cannot resolve {field}: {exc}") from exc
    return resolved


def _validate_host_path(path: Path, *, field: str) -> None:
    raw = os.fspath(path)
    try:
        encoded = raw.encode("utf-8", errors="strict")
    except UnicodeEncodeError as exc:
        raise ProductAgentInputError(f"{field} must be a valid UTF-8 path") from exc
    if (
        not encoded
        or len(encoded) > MAX_PATH_BYTES
        or any(ord(character) < 32 or ord(character) == 127 for character in raw)
    ):
        raise ProductAgentInputError(f"{field} is not a safe host path")


def _overlap(left: Path, right: Path) -> bool:
    return left == right or left.is_relative_to(right) or right.is_relative_to(left)


def _git(workspace: Path, *args: str) -> bytes:
    environment = {
        "PATH": os.environ.get("PATH", ""),
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_CONFIG_GLOBAL": os.devnull,
        "LC_ALL": "C",
    }
    try:
        process = subprocess.run(
            [
                "git",
                "-c",
                "core.fsmonitor=false",
                "-c",
                f"core.hooksPath={os.devnull}",
                "-c",
                "diff.external=",
                "-C",
                str(workspace),
                *args,
            ],
            capture_output=True,
            timeout=120,
            env=environment,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise ProductAgentInputError(f"could not inspect staged git workspace: {exc}") from exc
    if process.returncode != 0:
        detail = process.stderr[-512:].decode("utf-8", errors="replace").strip()
        raise ProductAgentInputError(
            f"staged workspace git inspection failed ({detail or process.returncode})"
        )
    return process.stdout


def _validate_repository(workspace: Path) -> str:
    try:
        metadata = workspace.stat()
    except OSError as exc:
        raise ProductAgentInputError(f"cannot inspect workspace: {exc}") from exc
    if not stat.S_ISDIR(metadata.st_mode):
        raise ProductAgentInputError("workspace must be a directory")

    top = Path(os.fsdecode(_git(workspace, "rev-parse", "--show-toplevel").strip())).resolve()
    if top != workspace:
        raise ProductAgentInputError("workspace must be the root of its git checkout")
    if _git(workspace, "status", "--porcelain=v1", "-z"):
        raise ProductAgentInputError("workspace must be clean before product-agent execution")

    commit = _git(workspace, "rev-parse", "--verify", "HEAD^{commit}").decode().strip()
    if len(commit) != 40 or any(character not in "0123456789abcdef" for character in commit):
        raise ProductAgentInputError("workspace HEAD did not resolve to an exact SHA-1 commit")

    entries = _git(workspace, "ls-tree", "-r", "-z", "--long", "HEAD").split(b"\0")
    files = 0
    total_bytes = 0
    tracked_paths: set[str] = set()
    for entry in entries:
        if not entry:
            continue
        try:
            header, raw_path = entry.split(b"\t", 1)
            mode, kind, _object_id, size = header.split(b" ", 3)
            path = os.fsdecode(raw_path)
        except ValueError as exc:
            raise ProductAgentInputError("workspace git tree contains a malformed entry") from exc
        if kind != b"blob" or mode not in {b"100644", b"100755"}:
            raise ProductAgentInputError(f"workspace contains an unsupported tracked entry: {path}")
        _validate_relative_path(path)
        if any(path == prefix or path.startswith(prefix + "/") for prefix in _RESERVED_PREFIXES):
            raise ProductAgentInputError(f"workspace uses reserved path: {path}")
        tracked_paths.add(path)
        files += 1
        total_bytes += int(size)
        if files > MAX_TRACKED_FILES or total_bytes > MAX_TRACKED_BYTES:
            raise ProductAgentInputError("workspace exceeds the product-agent v1 staging limits")

    expected_abox = {f".abox/{name}" for name in _COMPATIBILITY_ABOX_FILES}
    _validate_checkout_tree(workspace, tracked_paths)
    actual_abox = {path for path in tracked_paths if path == ".abox" or path.startswith(".abox/")}
    if actual_abox != expected_abox:
        raise ProductAgentInputError(
            "product-agent v1 supports only its two packaged self-host compatibility templates"
        )
    _validate_self_hosted_manifest(workspace)
    _validate_abox_templates(workspace)
    return commit


def _validate_relative_path(value: str) -> None:
    try:
        encoded = value.encode("utf-8", errors="strict")
    except UnicodeEncodeError as exc:
        raise ProductAgentInputError("workspace paths must be valid UTF-8") from exc
    path = PurePosixPath(value)
    if (
        not value
        or len(encoded) > MAX_PATH_BYTES
        or path.is_absolute()
        or any(part in {"", ".", ".."} for part in path.parts)
        or any(ord(character) < 32 or ord(character) == 127 for character in value)
    ):
        raise ProductAgentInputError(f"workspace contains an unsafe tracked path: {value!r}")


def _validate_checkout_tree(workspace: Path, tracked_paths: set[str]) -> None:
    """Reject untracked, linked, and special objects outside ``.git``.

    Git's porcelain status intentionally omits objects it cannot represent
    (for example FIFOs) and can omit ignored files. The staged v1 workspace is
    therefore checked against the exact HEAD tree with ``lstat`` semantics.
    Only directories required by tracked files and tracked regular files are
    permitted; repository metadata is opaque but its root object may not be a
    link or special file.
    """

    expected_directories: set[str] = set()
    for value in tracked_paths:
        parts = PurePosixPath(value).parts
        expected_directories.update("/".join(parts[:index]) for index in range(1, len(parts)))

    observed_files: set[str] = set()
    pending: list[tuple[Path, str]] = [(workspace, "")]
    while pending:
        directory, prefix = pending.pop()
        try:
            entries = list(os.scandir(directory))
        except OSError as exc:
            raise ProductAgentInputError(f"cannot inspect staged workspace tree: {exc}") from exc
        for entry in entries:
            relative = f"{prefix}/{entry.name}" if prefix else entry.name
            if not prefix and relative == ".git":
                if entry.is_symlink() or not (
                    entry.is_dir(follow_symlinks=False) or entry.is_file(follow_symlinks=False)
                ):
                    raise ProductAgentInputError(
                        "workspace .git must not be a link or special file"
                    )
                continue
            _validate_relative_path(relative)
            try:
                metadata = entry.stat(follow_symlinks=False)
            except OSError as exc:
                raise ProductAgentInputError(
                    f"cannot inspect staged workspace path {relative!r}: {exc}"
                ) from exc
            if stat.S_ISLNK(metadata.st_mode):
                raise ProductAgentInputError(
                    f"workspace path must not be a symbolic link: {relative}"
                )
            if stat.S_ISDIR(metadata.st_mode):
                if relative not in expected_directories:
                    raise ProductAgentInputError(
                        f"workspace contains an untracked directory: {relative}"
                    )
                pending.append((Path(entry.path), relative))
                continue
            if not stat.S_ISREG(metadata.st_mode):
                raise ProductAgentInputError(
                    f"workspace contains an unsupported special file: {relative}"
                )
            if relative not in tracked_paths:
                raise ProductAgentInputError(f"workspace contains an untracked file: {relative}")
            observed_files.add(relative)

    if observed_files != tracked_paths:
        missing = sorted(tracked_paths - observed_files)
        detail = missing[0] if missing else "unknown"
        raise ProductAgentInputError(f"workspace is missing tracked file: {detail}")


def _validate_self_hosted_manifest(workspace: Path) -> None:
    manifest = workspace / "pyproject.toml"
    package = workspace / "src" / "bakudo" / "__init__.py"
    if (
        not manifest.is_file()
        or manifest.is_symlink()
        or not package.is_file()
        or package.is_symlink()
    ):
        raise ProductAgentInputError("product-agent v1 supports only a Bakudo source workspace")
    try:
        document = tomllib.loads(manifest.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, tomllib.TOMLDecodeError) as exc:
        raise ProductAgentInputError(f"cannot parse workspace pyproject.toml: {exc}") from exc
    if document.get("project", {}).get("name") != "bakudo":
        raise ProductAgentInputError("workspace pyproject.toml is not the Bakudo project")


def _validate_abox_templates(workspace: Path) -> None:
    trusted_root = abox_templates_dir()
    for name in _COMPATIBILITY_ABOX_FILES:
        candidate = workspace / ".abox" / name
        trusted = trusted_root / name
        if candidate.is_symlink() or not candidate.is_file():
            raise ProductAgentInputError(f"workspace .abox/{name} must be a regular file")
        try:
            matches = candidate.read_bytes() == trusted.read_bytes()
        except OSError as exc:
            raise ProductAgentInputError(f"cannot verify workspace .abox/{name}: {exc}") from exc
        if not matches:
            raise ProductAgentInputError(
                f"workspace .abox/{name} does not match Bakudo's packaged compatibility template"
            )
    if not (workspace / ".abox" / "prepare.sh").stat().st_mode & stat.S_IXUSR:
        raise ProductAgentInputError("workspace .abox/prepare.sh must be executable")


def validate_input(
    workspace: str | Path,
    instruction_file: str | Path,
    output_dir: str | Path,
) -> ValidatedInput:
    resolved_workspace = _absolute(workspace, field="workspace", must_exist=True)
    instruction_path = _absolute(
        instruction_file,
        field="instruction-file",
        must_exist=True,
    )
    requested_output = Path(output_dir)
    _validate_host_path(requested_output, field="output-dir")
    if not requested_output.is_absolute():
        raise ProductAgentInputError("output-dir must be an absolute path")
    if requested_output.exists() or requested_output.is_symlink():
        raise ProductAgentInputError("output-dir must not already exist")
    output_parent = _absolute(
        requested_output.parent,
        field="output-dir parent",
        must_exist=True,
    )
    resolved_output = output_parent / requested_output.name
    if not output_parent.is_dir():
        raise ProductAgentInputError("output-dir parent must be a directory")
    if any(
        _overlap(left, right)
        for left, right in (
            (resolved_workspace, instruction_path),
            (resolved_workspace, resolved_output),
            (instruction_path, resolved_output),
        )
    ):
        raise ProductAgentInputError("workspace, instruction-file, and output-dir must not overlap")

    try:
        instruction_stat = instruction_path.stat()
    except OSError as exc:
        raise ProductAgentInputError(f"cannot inspect instruction-file: {exc}") from exc
    if not stat.S_ISREG(instruction_stat.st_mode):
        raise ProductAgentInputError("instruction-file must be a regular file")
    if instruction_stat.st_size > MAX_INSTRUCTION_BYTES:
        raise ProductAgentInputError("instruction-file exceeds the 2 MiB limit")
    try:
        instruction = instruction_path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        raise ProductAgentInputError(f"instruction-file must be readable UTF-8: {exc}") from exc
    if "\x00" in instruction:
        raise ProductAgentInputError("instruction-file must not contain NUL bytes")
    if not instruction.strip():
        raise ProductAgentInputError("instruction-file must not be empty")

    base_commit = _validate_repository(resolved_workspace)
    return ValidatedInput(
        workspace=resolved_workspace,
        instruction=instruction,
        output_dir=resolved_output,
        base_commit=base_commit,
    )


def publish_output(output_dir: Path, patch: bytes, result: ProductAgentResult) -> None:
    """Atomically publish the complete two-file result directory."""

    document = result.to_dict()
    encoded_result = (
        json.dumps(document, sort_keys=True, separators=(",", ":"), ensure_ascii=False) + "\n"
    ).encode("utf-8")
    temporary = Path(tempfile.mkdtemp(prefix=f".{output_dir.name}.tmp-", dir=output_dir.parent))
    try:
        temporary.chmod(0o700)
        patch_path = temporary / PATCH_FILENAME
        result_path = temporary / "result.json"
        patch_path.write_bytes(patch)
        result_path.write_bytes(encoded_result)
        for path in (patch_path, result_path):
            with path.open("rb") as stream:
                os.fsync(stream.fileno())
        directory_fd = os.open(temporary, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
        os.replace(temporary, output_dir)
        parent_fd = os.open(output_dir.parent, os.O_RDONLY)
        try:
            os.fsync(parent_fd)
        finally:
            os.close(parent_fd)
    except Exception:
        shutil.rmtree(temporary, ignore_errors=True)
        raise
