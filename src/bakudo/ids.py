"""Canonical, sortable identifiers shared across every subsystem.

The spec (section 6.3) calls for the *same* canonical ID to flow through
Temporal, abox, Postgres, the git branch suffix, and log correlation. We use
ULIDs: 26-character Crockford base32, lexicographically sortable by creation
time, and URL/branch-safe.

    Temporal workflow ID: run_01J...
    abox task ID:         run_01J...
    Postgres run ID:      run_01J...
    git branch suffix:    agent/run_01J...
    log correlation ID:   run_01J...
"""

from __future__ import annotations

import hashlib
import os
import time

# Crockford base32 alphabet (no I, L, O, U) — same as ULID.
_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
_ENCODE_LEN = 26


def _encode(value: int, length: int) -> str:
    chars = []
    for _ in range(length):
        value, rem = divmod(value, 32)
        chars.append(_ALPHABET[rem])
    return "".join(reversed(chars))


def new_ulid(now_ms: int | None = None) -> str:
    """Return a fresh 26-character ULID.

    The first 10 characters encode a 48-bit millisecond timestamp; the
    remaining 16 encode 80 bits of randomness.
    """
    if now_ms is None:
        now_ms = int(time.time() * 1000)
    rand = int.from_bytes(os.urandom(10), "big")  # 80 bits
    return _encode(now_ms, 10) + _encode(rand, 16)


def new_id(prefix: str) -> str:
    """Return a prefixed canonical id, e.g. ``run_01J...`` or ``obj_01J...``."""
    return f"{prefix}_{new_ulid()}"


def run_id() -> str:
    """A run identifier, reused verbatim across Temporal/abox/Postgres."""
    return new_id("run")


def objective_id() -> str:
    return new_id("obj")


def deterministic_objective_id(seed: str) -> str:
    """A stable, content-derived objective id (``objd_`` + 26 Crockford chars).

    Same format family as the other canonical ids, but hash-based instead of
    random: the same seed always yields the same id. The observer uses this so
    an unchanged repo signal (the same TODO, issue, failing test) maps to the
    SAME objective id every cycle, letting the meta workflow dedupe by id
    instead of dispatching duplicates forever (MEM-6). The distinct ``objd``
    prefix keeps observer-derived objectives distinguishable from operator/API
    ones (``obj_``).
    """
    digest = hashlib.sha256(seed.encode()).digest()
    value = int.from_bytes(digest, "big") % (32**_ENCODE_LEN)
    return f"objd_{_encode(value, _ENCODE_LEN)}"


def agent_version_id() -> str:
    return new_id("agentver")


def memory_id() -> str:
    return new_id("mem")


def promotion_id() -> str:
    return new_id("prom")


def artifact_id() -> str:
    return new_id("artifact")


def new_trial_id() -> str:
    return new_id("trial")


def new_experiment_id() -> str:
    return new_id("exp")


def git_branch_for(run: str) -> str:
    """The worktree branch name derived from a run id (section 6.3)."""
    return f"agent/{run}"
