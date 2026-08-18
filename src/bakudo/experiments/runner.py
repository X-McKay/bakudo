"""Subject-neutral synchronous experiment orchestration and analysis."""

from __future__ import annotations

import inspect
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from statistics import fmean
from typing import TYPE_CHECKING, Any

from ..ids import new_experiment_id
from ..trials.models import TrialRecord
from ..trials.runner import PipelineFn, build_pipeline_fn
from .artifact_subject import ArtifactMeasurementObserver, ArtifactSubjectBinding
from .models import (
    AgentSpecSubject,
    ExperimentObservation,
    ExperimentSpec,
    MetricDirection,
)
from .statistics import PairedAnalysis, analyze, task_deltas
from .subjects import AgentSubjectBinding, ObservationBatch, ObservationProvider

if TYPE_CHECKING:
    from ..abox.runner import AboxOutcome
    from ..agent_spec import AgentSpec
    from ..tasks.source import LoadedTask, TaskSource
    from ..tasks.verifier_runner import VerifierRunner


def adapt_sandbox_fn(
    sandbox: Callable[..., AboxOutcome],
) -> Callable[[Any, Path], AboxOutcome]:
    """Adapt the configured sandbox to the task-trial pipeline signature."""
    try:
        params: Mapping[str, inspect.Parameter] = inspect.signature(sandbox).parameters
    except (TypeError, ValueError):
        params = {}
    if "workspace_root" in params:

        def _with_workspace_root(bundle: Any, repo_path: Path) -> AboxOutcome:
            return sandbox(bundle, workspace_root=repo_path)

        return _with_workspace_root

    def _ignore_repo_path(bundle: Any, repo_path: Path) -> AboxOutcome:
        return sandbox(bundle)

    return _ignore_repo_path


def resolve_arm_pipeline_fn(
    spec: ExperimentSpec,
    *,
    sandbox_fn: Callable[[Any, Path], AboxOutcome],
    agents_root: Path,
) -> tuple[ExperimentSpec, PipelineFn]:
    """Resolve and pin every agent arm before task execution."""
    from ..agent_spec import load_spec_file

    subject = spec.subject
    if not isinstance(subject, AgentSpecSubject):
        raise TypeError("agent arm resolution requires an agent-spec subject")
    arm_refs = [subject.baseline, *subject.candidates]
    resolved_ref: dict[str, str] = {}
    per_arm: dict[str, PipelineFn] = {}
    for ref in arm_refs:
        if ref in resolved_ref:
            continue
        name, separator, version_string = ref.partition("@")
        agent_spec: AgentSpec = load_spec_file(agents_root / f"{name}.yaml")
        if separator:
            try:
                requested_version = int(version_string)
            except ValueError as exc:
                raise ValueError(
                    f"invalid agent version in {ref!r}: {version_string!r} is not an integer"
                ) from exc
            if agent_spec.metadata.version != requested_version:
                raise ValueError(
                    f"agent spec file for {name!r} is at version "
                    f"{agent_spec.metadata.version}, but arm {ref!r} requested "
                    f"version {requested_version}"
                )
        resolved_ref[ref] = agent_spec.ref
        per_arm[agent_spec.ref] = build_pipeline_fn(agent_spec, sandbox_fn=sandbox_fn)

    def pipeline_fn(objective: Any, agent_ref: str, budgets: Any, network: str) -> Any:
        return per_arm[agent_ref](objective, agent_ref, budgets, network)

    resolved_subject = subject.model_copy(
        update={
            "baseline": resolved_ref[subject.baseline],
            "candidates": [resolved_ref[candidate] for candidate in subject.candidates],
        }
    )
    return spec.model_copy(update={"subject": resolved_subject}), pipeline_fn


def subject_binding(
    spec: ExperimentSpec,
    *,
    ledger: Any,
    task_source: TaskSource | None = None,
    pipeline_fn: PipelineFn | None = None,
    verifier_runner: VerifierRunner | None = None,
    artifact_measure: ArtifactMeasurementObserver | None = None,
) -> ObservationProvider:
    """The sole synchronous subject-kind branch."""
    if isinstance(spec.subject, AgentSpecSubject):
        if task_source is None:
            raise ValueError("agent-spec experiments require task_source")
        return AgentSubjectBinding(
            spec,
            task_source=task_source,
            ledger=ledger,
            pipeline_fn=pipeline_fn,
            verifier_runner=verifier_runner,
        )
    if artifact_measure is None:
        raise ValueError("software-artifact experiments require artifact_measure")
    return ArtifactSubjectBinding(spec, ledger=ledger, measure=artifact_measure)


@dataclass(frozen=True)
class _MetricAnalysis:
    analysis: PairedAnalysis
    direction: MetricDirection | None
    valid: bool
    invalid_reasons: tuple[str, ...]


def _metric_series(
    observations: tuple[ExperimentObservation, ...],
    arm: str,
    name: str,
    *,
    invalid_contagious: bool,
) -> tuple[dict[str, list[float]], set[MetricDirection], tuple[str, ...]]:
    values: dict[str, list[float]] = {}
    directions: set[MetricDirection] = set()
    reasons: list[str] = []
    for observation in observations:
        if observation.arm != arm:
            continue
        metric = observation.metric(name)
        if metric is None:
            reasons.append(
                f"{arm}/{observation.pair_key}/{observation.repetition}: missing metric {name!r}"
            )
            continue
        directions.add(metric.direction)
        if invalid_contagious and (not metric.valid or not observation.integrity_valid):
            detail = metric.invalid_reasons or observation.degradation_reasons or (
                "invalid observation",
            )
            reasons.extend(
                f"{arm}/{observation.pair_key}/{observation.repetition}: {reason}"
                for reason in detail
            )
            continue
        normalized = metric.normalized_value
        if normalized is None:
            reasons.append(
                f"{arm}/{observation.pair_key}/{observation.repetition}: metric has no value"
            )
            continue
        values.setdefault(observation.pair_key, []).append(normalized)
    return values, directions, tuple(dict.fromkeys(reasons))


def _analyze_metric(
    spec: ExperimentSpec,
    provider: ObservationProvider,
    batch: ObservationBatch,
    candidate_arm: str,
    metric_name: str,
    *,
    cost_delta: float | None = None,
) -> _MetricAnalysis:
    baseline, baseline_directions, baseline_reasons = _metric_series(
        batch.observations,
        provider.baseline_arm,
        metric_name,
        invalid_contagious=provider.invalid_contagious,
    )
    candidate, candidate_directions, candidate_reasons = _metric_series(
        batch.observations,
        candidate_arm,
        metric_name,
        invalid_contagious=provider.invalid_contagious,
    )
    reasons = [*baseline_reasons, *candidate_reasons]
    directions = baseline_directions | candidate_directions
    if len(directions) != 1:
        reasons.append(f"metric {metric_name!r} does not have one consistent direction")
    if set(baseline) != set(candidate):
        reasons.append(f"metric {metric_name!r} does not have complete paired observations")
    valid = not reasons
    if not valid:
        analysis = PairedAnalysis(0, 0.0, 0.0, 0.0, 0, 0, 0, "tie")
    else:
        analysis = analyze(
            baseline,
            candidate,
            tie_zone=spec.decision.tie_zone,
            confidence=spec.decision.confidence,
            resamples=spec.decision.bootstrap_resamples,
            seed=0,
            cost_delta=cost_delta,
            cost_tiebreak=spec.decision.cost_tiebreak,
        )
    direction = next(iter(directions)) if len(directions) == 1 else None
    return _MetricAnalysis(analysis, direction, valid, tuple(dict.fromkeys(reasons)))


def _analysis_dict(value: _MetricAnalysis) -> dict[str, Any]:
    analysis = value.analysis
    return {
        "meanDelta": analysis.mean_delta,
        "ciLow": analysis.ci_low,
        "ciHigh": analysis.ci_high,
        "wins": analysis.wins,
        "losses": analysis.losses,
        "ties": analysis.ties,
        "verdict": analysis.verdict if value.valid else "inconclusive",
        "direction": value.direction.value if value.direction is not None else None,
        "valid": value.valid,
        "invalidReasons": list(value.invalid_reasons),
    }


def assemble_observation_result(
    spec: ExperimentSpec,
    provider: ObservationProvider,
    batch: ObservationBatch,
    *,
    experiment_id: str,
) -> dict[str, Any]:
    """Analyze either subject kind through one normalized metric pipeline."""
    result = provider.base_result(experiment_id, batch)
    if provider.profile:
        return result

    comparison: dict[str, Any] = {}
    for candidate_arm in provider.candidate_arms:
        cost_delta = provider.cost_delta(batch, candidate_arm)
        primary = _analyze_metric(
            spec,
            provider,
            batch,
            candidate_arm,
            spec.metrics.primary,
            cost_delta=cost_delta,
        )
        secondary: dict[str, dict[str, Any]] = {}
        for name in spec.metrics.secondary:
            metric = _analyze_metric(
                spec, provider, batch, candidate_arm, name
            )
            deltas = task_deltas(
                _metric_series(
                    batch.observations,
                    provider.baseline_arm,
                    name,
                    invalid_contagious=provider.invalid_contagious,
                )[0],
                _metric_series(
                    batch.observations,
                    candidate_arm,
                    name,
                    invalid_contagious=provider.invalid_contagious,
                )[0],
            )
            secondary[name] = {
                "meanDelta": fmean(deltas.values()) if metric.valid and deltas else 0.0,
                "direction": metric.direction.value if metric.direction else None,
                "valid": metric.valid,
                "invalidReasons": list(metric.invalid_reasons),
            }

        safety, integrity = provider.hard_gate_counts(batch, candidate_arm)
        eligible = (
            primary.valid
            and safety <= spec.hard_gates.safety_regressions
            and integrity <= spec.hard_gates.integrity_violations
            and primary.analysis.verdict == "candidate"
        )
        comparison[candidate_arm] = {
            "primary": _analysis_dict(primary),
            "secondary": secondary,
            "costDelta": cost_delta,
            "hardGates": {
                "safetyRegressions": safety,
                "integrityViolations": integrity,
            },
            "eligibleForPromotion": eligible,
        }
    result["comparison"] = comparison
    return result


def run_experiment(
    spec: ExperimentSpec,
    *,
    ledger: Any,
    task_source: TaskSource | None = None,
    pipeline_fn: PipelineFn | None = None,
    verifier_runner: VerifierRunner | None = None,
    artifact_measure: ArtifactMeasurementObserver | None = None,
) -> dict[str, Any]:
    """Run one experiment with exactly one subject-binding dispatch."""
    experiment_id = new_experiment_id()
    ledger.record_experiment(
        experiment_id,
        spec.metadata.name,
        spec.subject.kind,
        spec.to_dict(),
        "running",
    )
    provider = subject_binding(
        spec,
        ledger=ledger,
        task_source=task_source,
        pipeline_fn=pipeline_fn,
        verifier_runner=verifier_runner,
        artifact_measure=artifact_measure,
    )
    batch = provider.collect(experiment_id)
    result = assemble_observation_result(
        spec, provider, batch, experiment_id=experiment_id
    )
    ledger.update_experiment_result(experiment_id, "completed", result)
    return result


def assemble_result(
    spec: ExperimentSpec,
    trials: list[TrialRecord],
    *,
    tasks: list[LoadedTask],
    task_source: TaskSource,
) -> dict[str, Any]:
    """Assemble the agent binding from already-persisted TrialRecords."""
    if not isinstance(spec.subject, AgentSpecSubject):
        raise TypeError("TrialRecord assembly requires an agent-spec subject")
    experiment_id = next((trial.experiment_id for trial in trials if trial.experiment_id), "")
    provider = AgentSubjectBinding(
        spec,
        task_source=task_source,
        ledger=None,
        recorded_trials=trials,
        selected_tasks=tasks,
    )
    batch = provider.collect(experiment_id)
    return assemble_observation_result(
        spec, provider, batch, experiment_id=experiment_id
    )
