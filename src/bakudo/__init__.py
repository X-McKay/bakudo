"""bakudo — a durable, always-running meta-agent operating system.

bakudo creates, runs, evaluates, and evolves specialized agents over time.

The codebase is split into two planes (see ``docs/architecture.md``):

* **Control plane** (trusted): the meta-agent, registry, curriculum, eval
  coordination, memory services, and promotion logic. It schedules and
  evaluates but never executes arbitrary repository code.
* **Worker plane** (untrusted): individual versioned agents executed inside
  ``abox`` microVM sandboxes via the :mod:`bakudo.runner` entrypoint.

The central design principle:

    Every agent is a versioned artifact. Every run is evaluated. Every
    improvement is proposed as a candidate, tested, and promoted only if it
    improves measurable outcomes.
"""

__version__ = "3.0.0"

__all__ = ["__version__"]
