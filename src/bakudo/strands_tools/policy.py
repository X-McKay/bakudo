"""Command policy enforcement for the ``run-command`` tool.

abox provides the hard isolation boundary (microVM, scoped network, audited
syscalls). This policy is a *second*, in-process guard: it keeps the agent from
even attempting obviously out-of-scope commands, and records denials so they
surface in the run's safety eval (spec sections 18.2, 22.1).
"""

from __future__ import annotations

import shlex
from dataclasses import dataclass, field


class CommandDenied(Exception):
    """Raised when a command violates the active policy."""

    def __init__(self, command: str, reason: str):
        self.command = command
        self.reason = reason
        super().__init__(f"Command denied ({reason}): {command}")


# Interpreter inline-exec flags that turn an allowlisted, otherwise-safe program
# into an arbitrary-code executor (SEC-1). Checked against the *parsed* argv, so
# tab/space separators and quoting can't sneak past a raw-substring scan — e.g.
# `python -c "import os; os.system(...)"`, `find . -exec rm {} \;`,
# `bash -c '...'`, `node -e '...'`. This is defence-in-depth on top of abox, not
# a jail: it closes the cheap, obvious interpreter bypasses of the argv[0]
# allowlist without pretending to sandbox.
#
# Two match modes, because short options *cluster*: `python3 -Ic '...'`,
# `bash -lc '...'`, and `node -pe '...'` all execute inline code while no token
# equals `-c`/`-e`/`-p`. So single-letter code flags are matched against every
# letter of a short-option cluster, while long/multi-char flags match exactly.
_CODE_FLAG_LETTERS: dict[str, frozenset[str]] = {
    "python": frozenset("c"),
    "python3": frozenset("c"),
    "bash": frozenset("c"),
    "sh": frozenset("c"),
    "zsh": frozenset("c"),
    "node": frozenset("ep"),
    "perl": frozenset("eE"),
    "ruby": frozenset("e"),
}
_CODE_FLAG_EXACT: dict[str, frozenset[str]] = {
    "node": frozenset({"--eval", "--print"}),
    "deno": frozenset({"eval"}),
    "find": frozenset({"-exec", "-execdir", "-ok", "-okdir"}),
}


def _is_short_cluster(token: str) -> bool:
    """A single-dash short-option group like ``-Ic`` (not ``--long`` or ``-``)."""
    return (
        len(token) >= 2
        and token[0] == "-"
        and token[1] != "-"
        and "=" not in token
    )


@dataclass(frozen=True)
class CommandPolicy:
    """An allow/deny policy over command argv[0] and substrings.

    ``allowed_programs`` is the allowlist of permitted argv[0] values. An empty
    allowlist means "any program not explicitly denied". ``denied_substrings``
    blocks dangerous patterns regardless of the allowlist.
    """

    name: str
    allowed_programs: frozenset[str] = field(default_factory=frozenset)
    denied_substrings: tuple[str, ...] = ()

    def check(self, command: str) -> list[str]:
        """Validate a shell command, returning its argv. Raises on violation."""
        stripped = command.strip()
        if not stripped:
            raise CommandDenied(command, "empty")

        lowered = stripped.lower()
        for bad in self.denied_substrings:
            if bad in lowered:
                raise CommandDenied(command, f"contains forbidden pattern '{bad}'")

        try:
            argv = shlex.split(stripped)
        except ValueError as exc:
            raise CommandDenied(command, f"unparseable: {exc}") from exc
        if not argv:
            raise CommandDenied(command, "empty")

        program = argv[0].rsplit("/", 1)[-1]
        if self.allowed_programs and program not in self.allowed_programs:
            raise CommandDenied(command, f"program '{program}' not in allowlist")

        # Close the interpreter inline-exec bypass (SEC-1), including clustered
        # short options (`-Ic`, `-lc`, `-pe`): an allowlisted program invoked
        # with a code-execution flag runs arbitrary code the argv[0] allowlist
        # can't reason about.
        letters = _CODE_FLAG_LETTERS.get(program, frozenset())
        exact = _CODE_FLAG_EXACT.get(program, frozenset())
        # Exact code flags are denied anywhere in the argv (find's -exec
        # family legitimately follows positional paths), including the
        # `--flag=value` attached form (`node --eval=CODE`).
        for token in argv[1:]:
            if token in exact or token.split("=", 1)[0] in exact:
                raise CommandDenied(
                    command, f"'{program} {token}' can execute arbitrary code"
                )
        # Short-option clusters belong to the *interpreter* only while they
        # lead the argv; after the first positional (script path, module name,
        # subcommand) or a `--`, flags belong to the sub-program — `python -m
        # pytest -c pytest.ini` is pytest's -c, and denying it would hard-fail
        # the safety eval on benign commands. Stopping there leaves a known
        # gap (`python -W ignore -c CODE` hides -c behind an option value);
        # accepted — this guard closes cheap bypasses as defence-in-depth on
        # top of abox, it is not a jail.
        for token in argv[1:]:
            if token == "--" or not token.startswith("-"):
                break
            if letters and _is_short_cluster(token) and (set(token[1:]) & letters):
                raise CommandDenied(
                    command,
                    f"'{program} {token}' bundles an inline-code flag "
                    f"({', '.join(sorted(set(token[1:]) & letters))})",
                )
        return argv


# The default policy used by ``run-command`` with ``policy: repo-safe``. It
# permits the common read/build/test toolchain and blocks destructive,
# privilege-escalating, and exfiltration-prone patterns.
REPO_SAFE = CommandPolicy(
    name="repo-safe",
    allowed_programs=frozenset(
        {
            "ls", "cat", "head", "tail", "wc", "find", "tree", "stat",
            "grep", "rg", "sed", "awk", "diff",
            "git",
            "python", "python3", "pip", "uv", "pytest", "ruff", "mypy",
            "node", "npm", "npx", "pnpm", "yarn",
            "make", "just", "cargo", "go",
            "echo", "true", "test",
        }
    ),
    denied_substrings=(
        "rm -rf /",
        "sudo",
        "curl ",
        "wget ",
        "ssh ",
        "scp ",
        "nc ",
        "chmod 777",
        ":(){",          # fork bomb
        "/etc/passwd",
        "/etc/shadow",
        "~/.ssh",
        ".aws/credentials",
        "mkfs",
        "dd if=",
        "> /dev/sd",
    ),
)

# A read-only policy for the ``explore`` role.
READ_ONLY = CommandPolicy(
    name="read-only",
    allowed_programs=frozenset(
        {"ls", "cat", "head", "tail", "wc", "find", "tree", "stat", "grep", "rg", "git"}
    ),
    denied_substrings=REPO_SAFE.denied_substrings,
)

_POLICIES = {p.name: p for p in (REPO_SAFE, READ_ONLY)}


def policy_by_name(name: str | None) -> CommandPolicy:
    """Resolve a named policy, defaulting to ``repo-safe``."""
    if name is None:
        return REPO_SAFE
    if name not in _POLICIES:
        raise KeyError(f"Unknown command policy: {name}")
    return _POLICIES[name]
