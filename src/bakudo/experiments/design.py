"""Paired trial-matrix design (experiment substrate design doc section 7).

No RNG anywhere in this module: every seed is derived from a sha256 hash of
its inputs, so the same ``(experiment_id, scenario_name, repetition)`` always
produces the same seed, on any machine, without any stored state. Baseline
and candidate arms of the same (scenario, repetition) cell share that seed —
the "paired" part of the design — so a difference in outcome reflects the
agent version, not a different random draw.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass

from ..scenarios.models import Partition
from ..scenarios.registry import LoadedScenario, ScenarioRegistry
from .models import ExperimentSpec


def trial_seed(experiment_id: str, scenario_name: str, repetition: int) -> int:
    """A deterministic, hash-derived seed for one (experiment, scenario,
    repetition) cell. Baseline and every candidate arm of that cell call this
    with the same arguments and so share the same seed (see
    :func:`build_matrix`).

    Masked to 63 bits so the value always fits a signed 64-bit integer —
    the ledger persists it into a Postgres ``bigint`` column, which an
    unsigned 64-bit value overflows about half the time."""
    digest = hashlib.sha256(
        f"{experiment_id}:{scenario_name}:{repetition}".encode()
    ).digest()
    return int.from_bytes(digest[:8], "big") & 0x7FFF_FFFF_FFFF_FFFF


def _holdout_ok(spec: ExperimentSpec, scenario: LoadedScenario) -> bool:
    return spec.use_holdout or scenario.spec.metadata.partition != Partition.holdout


def select_scenarios(
    registry: ScenarioRegistry, spec: ExperimentSpec
) -> list[LoadedScenario]:
    """Resolve an :class:`ExperimentSpec`'s ``scenario_selector`` into a
    concrete, deterministically-ordered scenario list.

    - Filters by family (looping over ``families``, since
      :meth:`ScenarioRegistry.list` takes a single family), tags, and
      partitions.
    - Holdout guard: scenarios in the ``holdout`` partition are excluded
      unless ``spec.use_holdout`` is set, regardless of what the selector's
      own ``partitions`` list says — an experiment must opt in explicitly to
      touch holdout data.
    - Deterministic order: sorted by scenario name, then truncated to
      ``count``.
    - Twin closure: after truncation, any selected scenario's ``twin_of``
      sibling (and any scenario that names a selected one as ITS twin) is
      pulled in too, even beyond ``count`` and even if it falls outside the
      selector's family/tag/partition filters — a no-change/fix pair must be
      measured together or not at all. Twin closure still respects the
      holdout guard.
    """
    selector = spec.scenario_selector
    families: list[str | None] = list(selector.families) if selector.families else [None]
    tags = selector.tags or None
    partitions = selector.partitions or None

    matched: dict[str, LoadedScenario] = {}
    for family in families:
        for scenario in registry.list(family=family, partitions=partitions, tags=tags):
            matched.setdefault(scenario.ref, scenario)

    candidates = sorted(
        (s for s in matched.values() if _holdout_ok(spec, s)),
        key=lambda s: s.spec.metadata.name,
    )
    selected = {s.spec.metadata.name: s for s in candidates[: selector.count]}

    # Twin closure. Looked up against the whole registry (unfiltered) since
    # a twin can legitimately sit in a different family/partition than the
    # selector asked for.
    by_name = {s.spec.metadata.name: s for s in registry.list()}
    frontier = list(selected)
    while frontier:
        name = frontier.pop()
        scenario = selected[name]
        related_names = set()
        if scenario.spec.metadata.twin_of:
            related_names.add(scenario.spec.metadata.twin_of)
        related_names.update(
            other_name
            for other_name, other in by_name.items()
            if other.spec.metadata.twin_of == name
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
    """One (scenario, repetition, arm) cell of an experiment's trial matrix,
    not yet run."""

    agent_ref: str
    scenario: LoadedScenario
    seed: int
    repetition: int
    arm: str  # "baseline" or the candidate's agent_ref


def build_matrix(
    spec: ExperimentSpec,
    scenarios: list[LoadedScenario],
    experiment_id: str,
) -> list[PlannedTrial]:
    """The full trial matrix: one row per (scenario, repetition, arm).

    The baseline arm and every candidate arm of a given (scenario,
    repetition) cell share :func:`trial_seed` — the pairing that lets a
    downstream statistics pass attribute an outcome difference to the agent
    version rather than to scenario randomness. With ``spec.candidates``
    empty (profile mode) every row's arm is ``"baseline"``.
    """
    arms = [spec.baseline, *spec.candidates]
    trials = []
    for scenario in scenarios:
        scenario_name = scenario.spec.metadata.name
        for repetition in range(spec.repetitions):
            seed = trial_seed(experiment_id, scenario_name, repetition)
            for agent_ref in arms:
                arm = "baseline" if agent_ref == spec.baseline else agent_ref
                trials.append(
                    PlannedTrial(
                        agent_ref=agent_ref,
                        scenario=scenario,
                        seed=seed,
                        repetition=repetition,
                        arm=arm,
                    )
                )
    return trials
