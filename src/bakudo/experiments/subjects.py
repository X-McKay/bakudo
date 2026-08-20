"""Subject-binding port and the task-backed agent implementation."""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import UTC, datetime
from statistics import fmean
from typing import Any, Protocol

from ..ids import new_episode_id, new_trial_id
from ..trials.models import IntegrityFlags, TrialRecord
from ..trials.runner import PipelineFn, run_trial
from .design import PlannedTrial, build_matrix, select_tasks
from .models import (
    AgentSpecSubject,
    AgentTrialEvidence,
    ExperimentObservation,
    ExperimentSpec,
    ObservationMetric,
)


@dataclass(frozen=True)
class ObservationBatch:
    observations: tuple[ExperimentObservation, ...]
    context: object


class ObservationProvider(Protocol):
    """One subject-specific boundary around observation production."""

    @property
    def subject_kind(self) -> str: ...

    @property
    def baseline_arm(self) -> str: ...

    @property
    def candidate_arms(self) -> tuple[str, ...]: ...

    @property
    def profile(self) -> bool: ...

    @property
    def invalid_contagious(self) -> bool: ...

    def collect(self, experiment_id: str) -> ObservationBatch: ...

    def base_result(self, experiment_id: str, batch: ObservationBatch) -> dict[str, Any]: ...

    def hard_gate_counts(self, batch: ObservationBatch, arm: str) -> tuple[int, int]: ...

    def cost_delta(self, batch: ObservationBatch, arm: str) -> float | None: ...


@dataclass(frozen=True)
class AgentObservationContext:
    trials: tuple[TrialRecord, ...]
    tasks: tuple[Any, ...]
    task_source: Any


def _has_integrity_violation(integrity: IntegrityFlags) -> bool:
    return bool(
        integrity.verifier_input_violation
        or integrity.denied_action_violation
        or integrity.scope_violation
        or integrity.change_limit_violation
    )


def _failed_trial_record(planned: PlannedTrial, experiment_id: str, exc: Exception) -> TrialRecord:
    now = datetime.now(UTC).isoformat()
    return TrialRecord(
        id=new_trial_id(),
        episode_id=new_episode_id(),
        experiment_id=experiment_id,
        agent_ref=planned.agent_ref,
        task=planned.task.pin,
        seed=planned.seed,
        runtime_pins={},
        metrics={},
        evaluation={"f2p_rate": 0.0, "p2p_rate": 0.0, "error": str(exc)},
        integrity=IntegrityFlags(),
        status="failed",
        started_at=now,
        completed_at=now,
    )


def _sanitize_metric(raw: Any) -> tuple[float, bool]:
    if raw is None:
        return 0.0, True
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return 0.0, True
    if not math.isfinite(value):
        return 0.0, True
    return value, False


class AgentSubjectBinding:
    """Run task trials and expose them as generic experiment observations."""

    def __init__(
        self,
        spec: ExperimentSpec,
        *,
        task_source: Any,
        ledger: Any,
        pipeline_fn: PipelineFn | None = None,
        verifier_runner: Any = None,
        recorded_trials: list[TrialRecord] | None = None,
        selected_tasks: list[Any] | None = None,
    ) -> None:
        if not isinstance(spec.subject, AgentSpecSubject):
            raise TypeError("AgentSubjectBinding requires an agent-spec subject")
        self.spec = spec
        self.subject = spec.subject
        self.task_source = task_source
        self.ledger = ledger
        self.pipeline_fn = pipeline_fn
        self.verifier_runner = verifier_runner
        self._recorded_trials = recorded_trials
        self._selected_tasks = selected_tasks

    @property
    def subject_kind(self) -> str:
        return self.subject.kind

    @property
    def baseline_arm(self) -> str:
        return self.subject.baseline

    @property
    def candidate_arms(self) -> tuple[str, ...]:
        return tuple(self.subject.candidates)

    @property
    def profile(self) -> bool:
        return not self.subject.candidates

    @property
    def invalid_contagious(self) -> bool:
        # Preserve the historical behavioral experiment rule: unavailable
        # agent metrics score zero and are surfaced via degradedTrials.
        return False

    def _run_trials(self, experiment_id: str, tasks: list[Any]) -> list[TrialRecord]:
        if self.pipeline_fn is None or self.verifier_runner is None:
            raise ValueError("agent observation requires pipeline_fn and verifier_runner")
        records: list[TrialRecord] = []
        for planned in build_matrix(self.spec, tasks, experiment_id):
            try:
                trial = run_trial(
                    planned.task,
                    planned.agent_ref,
                    planned.seed,
                    pipeline_fn=self.pipeline_fn,
                    verifier_runner=self.verifier_runner,
                    ledger=self.ledger,
                    experiment_id=experiment_id,
                )
            except Exception as exc:  # noqa: BLE001 - failed cells remain observations
                trial = _failed_trial_record(planned, experiment_id, exc)
                self.ledger.record_trial(trial)
            records.append(trial)
        return records

    def _observation_metrics(
        self, trial: TrialRecord
    ) -> tuple[tuple[ObservationMetric, ...], tuple[str, ...]]:
        names = [self.spec.metrics.primary, *self.spec.metrics.secondary]
        if "tokens" not in names:
            names.append("tokens")
        metrics: list[ObservationMetric] = []
        degraded: list[str] = []
        for name in names:
            if name == "task_success":
                raw = trial.evaluation.get("f2p_rate")
            else:
                raw = trial.metrics.get(name)
            value, missing = _sanitize_metric(raw)
            # Cost is not declared experiment evidence and historically
            # defaults to zero without degrading the selected metrics.
            if missing and name != "tokens":
                degraded.append(f"metric {name!r} is missing or non-finite")
            metrics.append(
                ObservationMetric(
                    name=name,
                    value=value,
                    direction=self.spec.metrics.direction_for(name),
                )
            )
        return tuple(metrics), tuple(degraded)

    def _observations(
        self, experiment_id: str, trials: list[TrialRecord]
    ) -> tuple[ExperimentObservation, ...]:
        repetitions: dict[tuple[str, str], int] = {}
        observations: list[ExperimentObservation] = []
        for trial in trials:
            key = (trial.agent_ref, trial.task.name)
            repetition = repetitions.get(key, 0)
            repetitions[key] = repetition + 1
            metrics, degraded = self._observation_metrics(trial)
            observations.append(
                ExperimentObservation(
                    experiment_id=experiment_id,
                    subject_kind="agent-spec",
                    arm=trial.agent_ref,
                    pair_key=trial.task.name,
                    repetition=repetition,
                    metrics=metrics,
                    integrity_valid=not _has_integrity_violation(trial.integrity),
                    degraded=bool(degraded),
                    degradation_reasons=degraded,
                    evidence=AgentTrialEvidence(trial=trial),
                )
            )
        return tuple(observations)

    def collect(self, experiment_id: str) -> ObservationBatch:
        tasks = (
            self._selected_tasks
            if self._selected_tasks is not None
            else select_tasks(self.task_source, self.spec)
        )
        trials = (
            self._recorded_trials
            if self._recorded_trials is not None
            else self._run_trials(experiment_id, tasks)
        )
        return ObservationBatch(
            self._observations(experiment_id, trials),
            AgentObservationContext(tuple(trials), tuple(tasks), self.task_source),
        )

    @staticmethod
    def _context(batch: ObservationBatch) -> AgentObservationContext:
        if not isinstance(batch.context, AgentObservationContext):
            raise TypeError("agent observation batch has the wrong context")
        return batch.context

    def hard_gate_counts(self, batch: ObservationBatch, arm: str) -> tuple[int, int]:
        trials = self._context(batch).trials
        safety = sum(
            int((trial.evaluation.get("scorecard") or {}).get("safety_regressions", 0) or 0)
            for trial in trials
            if trial.agent_ref == arm
        )
        integrity = sum(
            1
            for trial in trials
            if trial.agent_ref == arm and _has_integrity_violation(trial.integrity)
        )
        return safety, integrity

    @staticmethod
    def _series(
        observations: tuple[ExperimentObservation, ...], arm: str, metric_name: str
    ) -> dict[str, list[float]]:
        values: dict[str, list[float]] = {}
        for observation in observations:
            if observation.arm != arm:
                continue
            metric = observation.metric(metric_name)
            if metric is None or metric.value is None:
                continue
            values.setdefault(observation.pair_key, []).append(metric.value)
        return values

    def cost_delta(self, batch: ObservationBatch, arm: str) -> float | None:
        baseline = self._series(batch.observations, self.baseline_arm, "tokens")
        candidate = self._series(batch.observations, arm, "tokens")
        baseline_values = [value for values in baseline.values() for value in values]
        candidate_values = [value for values in candidate.values() for value in values]
        if not baseline_values or not candidate_values:
            return 0.0
        baseline_mean = fmean(baseline_values)
        if baseline_mean == 0:
            return 0.0
        return (fmean(candidate_values) - baseline_mean) / baseline_mean

    def base_result(self, experiment_id: str, batch: ObservationBatch) -> dict[str, Any]:
        context = self._context(batch)
        tasks = list(context.tasks)
        trials = list(context.trials)
        family_by_name = {
            task.spec.metadata.name: task.spec.metadata.family.value for task in tasks
        }
        return {
            "experimentId": experiment_id,
            "subjectKind": self.subject_kind,
            "subject": self.subject.model_dump(by_alias=True, mode="json"),
            "corpus": {
                "sourceURI": context.task_source.source_uri,
                "revision": context.task_source.corpus_revision,
                "tasks": [task.pin.model_dump(mode="json") for task in tasks],
            },
            "usedHoldout": self.subject.use_holdout,
            "profile": self.profile,
            "baseline": self.baseline_arm,
            "candidates": list(self.candidate_arms),
            "perFamily": _per_family(self.spec, trials, family_by_name),
            "pairedTaskPairs": _paired_task_pairs(self.spec, tasks, context.task_source, trials),
            "degradedTrials": sum(
                1
                for observation in batch.observations
                if observation.degraded
                and isinstance(observation.evidence, AgentTrialEvidence)
                and observation.evidence.trial.status == "completed"
            ),
            "observationRecords": [
                {
                    "arm": observation.arm,
                    "pairKey": observation.pair_key,
                    "repetition": observation.repetition,
                    "kind": "trial-record",
                    "id": observation.evidence.trial.id,
                }
                for observation in batch.observations
                if isinstance(observation.evidence, AgentTrialEvidence)
            ],
        }


def _primary_value(spec: ExperimentSpec, trial: TrialRecord) -> float:
    raw = (
        trial.evaluation.get("f2p_rate")
        if spec.metrics.primary == "task_success"
        else trial.metrics.get(spec.metrics.primary)
    )
    return _sanitize_metric(raw)[0]


def _per_family(
    spec: ExperimentSpec,
    trials: list[TrialRecord],
    family_by_name: dict[str, str],
) -> dict[str, dict[str, Any]]:
    subject = spec.subject
    if not isinstance(subject, AgentSpecSubject):
        raise TypeError("per-family results require an agent-spec subject")
    result: dict[str, dict[str, Any]] = {}
    for family in sorted(set(family_by_name.values())):
        names = {name for name, value in family_by_name.items() if value == family}
        baseline = [
            _primary_value(spec, trial)
            for trial in trials
            if trial.agent_ref == subject.baseline and trial.task.name in names
        ]
        candidates: dict[str, float] = {}
        for arm in subject.candidates:
            values = [
                _primary_value(spec, trial)
                for trial in trials
                if trial.agent_ref == arm and trial.task.name in names
            ]
            candidates[arm] = fmean(values) if values else 0.0
        result[family] = {
            "baselineMean": fmean(baseline) if baseline else 0.0,
            "candidateMeans": candidates,
        }
    return result


def _joint_pass(nochange: list[TrialRecord], fix: list[TrialRecord]) -> bool:
    if not nochange or not fix:
        return False
    return all(
        trial.evaluation.get("p2p_rate") == 1.0 and trial.metrics.get("changed_files") == 0.0
        for trial in nochange
    ) and all(trial.evaluation.get("f2p_rate") == 1.0 for trial in fix)


def _paired_task_pairs(
    spec: ExperimentSpec,
    tasks: list[Any],
    task_source: Any,
    trials: list[TrialRecord],
) -> list[dict[str, Any]]:
    subject = spec.subject
    if not isinstance(subject, AgentSpecSubject):
        raise TypeError("paired-task results require an agent-spec subject")
    selected = {task.spec.metadata.name: task for task in tasks}
    all_tasks = {task.spec.metadata.name: task for task in task_source.list()}
    pairs = {
        (name, task.spec.metadata.paired_task)
        for name, task in all_tasks.items()
        if task.spec.metadata.paired_task
        and (name in selected or task.spec.metadata.paired_task in selected)
    }
    result: list[dict[str, Any]] = []
    for nochange_name, fix_name in sorted(pairs):
        nochange = selected.get(nochange_name) or all_tasks.get(nochange_name)
        fix = selected.get(fix_name) or all_tasks.get(fix_name)
        item: dict[str, Any] = {
            "noChange": nochange.ref if nochange else nochange_name,
            "fix": fix.ref if fix else fix_name,
        }
        if nochange_name not in selected or fix_name not in selected:
            item["incomplete"] = True
            result.append(item)
            continue
        joint: dict[str, bool] = {}
        arms = [("baseline", subject.baseline), *((arm, arm) for arm in subject.candidates)]
        for label, arm in arms:
            nochange_trials = [
                trial
                for trial in trials
                if trial.agent_ref == arm and trial.task.name == nochange_name
            ]
            fix_trials = [
                trial for trial in trials if trial.agent_ref == arm and trial.task.name == fix_name
            ]
            joint[label] = _joint_pass(nochange_trials, fix_trials)
        item["jointPass"] = joint
        result.append(item)
    return result
