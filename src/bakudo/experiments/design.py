"""Paired trial-matrix design (experiment substrate design doc section 7).

No RNG anywhere in this module: every seed is derived from a sha256 hash of
its inputs, so the same ``(experiment_id, task_name, repetition)`` always
produces the same seed, on any machine, without any stored state. Baseline
and candidate arms of the same (task, repetition) cell share that seed —
the "paired" part of the design — so a difference in outcome reflects the
agent version, not a different random draw.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass

from ..tasks.models import Partition
from ..tasks.source import LoadedTask, TaskSource
from .models import ExperimentSpec


def trial_seed(experiment_id: str, task_name: str, repetition: int) -> int:
    """A deterministic, hash-derived seed for one (experiment, task,
    repetition) cell. Baseline and every candidate arm of that cell call this
    with the same arguments and so share the same seed (see
    :func:`build_matrix`).

    Masked to 63 bits so the value always fits a signed 64-bit integer —
    the ledger persists it into a Postgres ``bigint`` column, which an
    unsigned 64-bit value overflows about half the time."""
    digest = hashlib.sha256(f"{experiment_id}:{task_name}:{repetition}".encode()).digest()
    return int.from_bytes(digest[:8], "big") & 0x7FFF_FFFF_FFFF_FFFF


def _holdout_ok(spec: ExperimentSpec, task: LoadedTask) -> bool:
    return spec.use_holdout or task.spec.metadata.partition != Partition.holdout


def select_tasks(source: TaskSource, spec: ExperimentSpec) -> list[LoadedTask]:
    """Resolve an :class:`ExperimentSpec`'s ``task_selector`` into a
    concrete, deterministically-ordered task list.

    - Filters by family (looping over ``families``, since
      :meth:`TaskSource.list` takes a single family), tags, and
      partitions.
    - Holdout guard: tasks in the ``holdout`` partition are excluded
      unless ``spec.use_holdout`` is set, regardless of what the selector's
      own ``partitions`` list says — an experiment must opt in explicitly to
      touch holdout data.
    - Deterministic order: sorted by task name, then truncated to
      ``count``.
    - Paired-task closure: after truncation, any selected task's ``paired_task``
      sibling (and any task that names a selected one as ITS paired task) is
      pulled in too, even beyond ``count`` and even if it falls outside the
      selector's family/tag/partition filters — a no-change/fix pair must be
      measured together or not at all. Paired-task closure still respects the
      holdout guard.
    """
    selector = spec.task_selector
    families: list[str | None] = list(selector.families) if selector.families else [None]
    tags = selector.tags or None
    partitions = selector.partitions or None

    matched: dict[str, LoadedTask] = {}
    for family in families:
        for task in source.list(family=family, partitions=partitions, tags=tags):
            matched.setdefault(task.ref, task)

    candidates = sorted(
        (s for s in matched.values() if _holdout_ok(spec, s)),
        key=lambda s: s.spec.metadata.name,
    )
    selected = {s.spec.metadata.name: s for s in candidates[: selector.count]}

    # Paired-task closure. Looked up against the whole source (unfiltered) since
    # a paired task can legitimately sit in a different family/partition than the
    # selector asked for.
    by_name = {s.spec.metadata.name: s for s in source.list()}
    frontier = list(selected)
    while frontier:
        name = frontier.pop()
        task = selected[name]
        related_names = set()
        if task.spec.metadata.paired_task:
            related_names.add(task.spec.metadata.paired_task)
        related_names.update(
            other_name
            for other_name, other in by_name.items()
            if other.spec.metadata.paired_task == name
        )
        for related_name in related_names:
            if related_name in selected:
                continue
            related = by_name.get(related_name)
            if related is not None and _holdout_ok(spec, related):
                selected[related_name] = related
                frontier.append(related_name)

    return sorted(selected.values(), key=lambda s: s.spec.metadata.name)


@dataclass(frozen=True)
class PlannedTrial:
    """One (task, repetition, arm) cell of an experiment's trial matrix,
    not yet run."""

    agent_ref: str
    task: LoadedTask
    seed: int
    repetition: int
    arm: str  # "baseline" or the candidate's agent_ref


def build_matrix(
    spec: ExperimentSpec,
    tasks: list[LoadedTask],
    experiment_id: str,
) -> list[PlannedTrial]:
    """The full trial matrix: one row per (task, repetition, arm).

    The baseline arm and every candidate arm of a given (task,
    repetition) cell share :func:`trial_seed` — the pairing that lets a
    downstream statistics pass attribute an outcome difference to the agent
    version rather than to task randomness. With ``spec.candidates``
    empty (profile mode) every row's arm is ``"baseline"``.
    """
    arms = [spec.baseline, *spec.candidates]
    trials = []
    for task in tasks:
        task_name = task.spec.metadata.name
        for repetition in range(spec.repetitions):
            seed = trial_seed(experiment_id, task_name, repetition)
            for agent_ref in arms:
                arm = "baseline" if agent_ref == spec.baseline else agent_ref
                trials.append(
                    PlannedTrial(
                        agent_ref=agent_ref,
                        task=task,
                        seed=seed,
                        repetition=repetition,
                        arm=arm,
                    )
                )
    return trials
