"""Flat staging of pinned workload members into abox guests.

abox ``--input-file`` rejects guest names containing "/" ("must be a plain
file name"), so measurement and capture stage every pinned member flat under
a unique sanitized guest name, and the in-guest bootstrap reconstructs the
workload layout at :data:`GUEST_WORKLOAD_ROOT` before anything executes.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import NamedTuple

from ..performance.verify import iter_workload_files

# Where the in-guest bootstrap reconstructs the staged workload layout.
GUEST_WORKLOAD_ROOT = "/tmp/bakudo-workload"

# abox parses ``<hostpath>[:<guestname>]`` and validates guest names, so a
# member name may not smuggle separators or shell-hostile characters into the
# staged name. Flat names stay index-unique, so this substitution can never
# collide two members.
_GUEST_NAME_UNSAFE = re.compile(r"[^A-Za-z0-9._-]")

# Keep flat names comfortably under the 255-byte filename limit even after
# the ``w<i>-`` prefix; the reconstruction map, not the flat name, carries
# the member's real path, so truncation loses nothing.
_GUEST_NAME_MAX_CHARS = 64

# The staging map travels as one JSON argv element; Linux caps a single argv
# element at MAX_ARG_STRLEN (128 KiB). Callers fail closed with a typed error
# beyond this bound instead of dying in execve with E2BIG.
MAX_GUEST_PAYLOAD_CHARS = 100_000

# Shared guest-side bootstrap: parse the payload, rebuild the workload layout
# from the flat inputs, restore the executable bit staging drops, and export
# BAKUDO_WORKLOAD_DIR so workload code can locate members without relying on
# the working directory (which stays the repository worktree). Runs before
# any measurement clock starts, so reconstruction never contaminates timing.
# Composed into the measurement wrapper and the capture launcher.
GUEST_RECONSTRUCT_SNIPPET = r"""
import json, os, shutil, sys
payload = json.loads(sys.argv[1])
inputs_dir = os.environ.get("ABOX_INPUT_DIR", "/abox-meta/inputs")
executables = set(payload["executables"])
for flat_name, relative in payload["files"].items():
    destination = os.path.join(payload["workload_root"], relative)
    os.makedirs(os.path.dirname(destination), exist_ok=True)
    shutil.copyfile(os.path.join(inputs_dir, flat_name), destination)
    if flat_name in executables:
        os.chmod(destination, 0o755)
os.environ["BAKUDO_WORKLOAD_DIR"] = payload["workload_root"]
"""


class StagedFile(NamedTuple):
    guest_name: str
    host_path: Path
    relative_path: str
    executable: bool


def staged_workload_files(root: Path) -> tuple[StagedFile, ...]:
    """The pinned content set with its flat guest names, in pinned order."""
    return tuple(
        StagedFile(
            guest_name=(
                f"w{index}-{_GUEST_NAME_UNSAFE.sub('_', path.name)[:_GUEST_NAME_MAX_CHARS]}"
            ),
            host_path=path,
            relative_path=path.relative_to(root).as_posix(),
            executable=bool(path.stat().st_mode & 0o111),
        )
        for index, path in enumerate(iter_workload_files(root))
    )


def staging_payload_fields(staged: tuple[StagedFile, ...]) -> dict[str, object]:
    """The payload keys the guest bootstrap consumes."""
    return {
        "files": {member.guest_name: member.relative_path for member in staged},
        "executables": [member.guest_name for member in staged if member.executable],
        "workload_root": GUEST_WORKLOAD_ROOT,
    }


def staging_input_arguments(staged: tuple[StagedFile, ...]) -> list[str]:
    """The ``--input-file`` argv fragment staging every member."""
    arguments: list[str] = []
    for member in staged:
        arguments += ["--input-file", f"{member.host_path}:{member.guest_name}"]
    return arguments
