"""Synchronous experiment runner and result assembly (experiment substrate
design doc sections 7.4/7.5).

:func:`run_experiment` is the in-process (non-Temporal) counterpart to the
design doc's ``ExperimentWorkflow`` sketch: resolve tasks -> build the
paired trial matrix -> run every planned trial sequentially via
:func:`bakudo.trials.runner.run_trial` -> assemble the result -> persist ->
return. Task 11 replaces the sequential loop with fanned-out Temporal
children over the same matrix/statistics building blocks; nothing here is
Temporal-shaped.
"""

from __future__ import annotations

import inspect
import math
from collections.abc import Callable, Mapping
from datetime import UTC, datetime
from pathlib import Path
from statistics import fmean
from typing import TYPE_CHECKING, Any

from ..ids import new_episode_id, new_experiment_id, new_trial_id
from ..trials.models import IntegrityFlags, TrialRecord
from ..trials.runner import PipelineFn, build_pipeline_fn, run_trial
from .design import PlannedTrial, build_matrix, select_tasks
from .models import ExperimentSpec
from .statistics import analyze, task_deltas

if TYPE_CHECKING:
    from ..abox.runner import AboxOutcome
    from ..agent_spec import AgentSpec
    from ..tasks.source import LoadedTask, TaskSource
    from ..tasks.verifier_runner import VerifierRunner


# --------------------------------------------------------------------------
# Sandbox / pipeline_fn wiring shared by the CLI and the API
# --------------------------------------------------------------------------


def adapt_sandbox_fn(
    sandbox: Callable[..., AboxOutcome],
) -> Callable[[Any, Path], AboxOutcome]:
    """Adapt a single-arg ``SandboxFn`` (``Callable[[AgentRunBundle], AboxOutcome]``
    -- what :meth:`bakudo.temporal._impl.Deps.sandbox_fn` resolves, and what
    the API's ``resolve_sandbox`` returns) into the two-arg
    ``Callable[[AgentRunBundle, Path], AboxOutcome]`` shape
    :func:`bakudo.trials.runner.build_pipeline_fn` requires.

    ``local_sandbox`` accepts an optional ``workspace_root`` keyword so a
    trial's own provisioned workspace can be reused directly (the CLI's own
    ``_cmd_trial_run`` does this with an explicit lambda); the live abox
    runner resolves its own repo from the bundle and has no such parameter.
    Detected via introspection so this adapter works for either without the
    caller having to know which one it got.
    """
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
    """Resolve every arm's :class:`~bakudo.agent_spec.models.AgentSpec` and
    build a ``pipeline_fn`` for :func:`run_experiment` that dispatches to it.

    Every arm (the baseline ref plus every candidate ref) resolves its spec
    the same way ``bakudo trial run`` does: ``agents_root/<name>.yaml``, with
    an ``@version`` pin (when given) checked against what is actually on
    disk. Each arm's spec is wrapped with
    :func:`bakudo.trials.runner.build_pipeline_fn` so that arm's own
    budget/network intersection (against whatever task ceiling
    ``run_trial`` passes down) is computed against THAT spec, not just the
    baseline's -- a candidate agent with a tighter budget must not silently
    inherit the baseline's looser one.

    Returns ``(resolved_spec, pipeline_fn)``: ``resolved_spec`` is ``spec``
    with ``baseline``/``candidates`` rewritten from whatever the caller gave
    (bare name, or ``name@version``) to each arm's ACTUAL loaded
    ``spec.ref`` (``name@version``). This matters even for an already-pinned
    ref (kept as-is once it matches, by definition) but especially for an
    unpinned one: an unpinned "debugger" must not end up recorded verbatim
    in ``TrialRecord.agent_ref`` and result baseline/candidates/comparison
    keys while a concrete on-disk version actually ran -- the caller MUST
    use ``resolved_spec``, not ``spec``, for :func:`run_experiment` (and for
    ``build_matrix``/``select_tasks`` generally), since ``pipeline_fn``
    below is keyed by the resolved refs, not the caller's originals.

    Raises ``ValueError`` when an ``@version``-pinned ref does not match the
    on-disk spec's version, or when the ref's spec file is malformed;
    ``FileNotFoundError`` when no spec file exists for the name at all
    (unknown agent) -- both caught and mapped by callers (CLI: exit 2; API:
    422/404).
    """
    from ..agent_spec import load_spec_file

    arm_refs = [spec.baseline, *spec.candidates]
    resolved_ref: dict[str, str] = {}
    per_arm: dict[str, PipelineFn] = {}
    for ref in arm_refs:
        if ref in resolved_ref:
            continue
        name, sep, version_s = ref.partition("@")
        agent_spec: AgentSpec = load_spec_file(agents_root / f"{name}.yaml")
        if sep:
            try:
                requested_version = int(version_s)
            except ValueError as exc:
                raise ValueError(
                    f"invalid agent version in {ref!r}: {version_s!r} is not an integer"
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

    resolved_spec = spec.model_copy(
        update={
            "baseline": resolved_ref[spec.baseline],
            "candidates": [resolved_ref[c] for c in spec.candidates],
        }
    )
    return resolved_spec, pipeline_fn


# --------------------------------------------------------------------------
# run_experiment
# --------------------------------------------------------------------------


def _failed_trial_record(planned: PlannedTrial, experiment_id: str, exc: Exception) -> TrialRecord:
    """Ruling (c): a raised ``pipeline_fn``/verifier-eval exception is caught
    HERE (``run_trial`` itself still propagates -- Task 7 behavior), scored
    as a failed trial with zeroed evaluation, so the experiment completes."""
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


def run_experiment(
    spec: ExperimentSpec,
    *,
    task_source: TaskSource,
    ledger: Any,
    pipeline_fn: PipelineFn,
    verifier_runner: VerifierRunner,
) -> dict[str, Any]:
    """Run one experiment end to end, synchronously, in process.

    record_experiment(status="running") -> select_tasks -> build_matrix
    -> run_trial per :class:`~bakudo.experiments.design.PlannedTrial`
    (sequentially -- Task 11 fans this out over Temporal) -> assemble_result
    -> update_experiment_result(status="completed") -> return the result.

    A trial whose ``pipeline_fn``/verifier-eval raises is caught here (ruling
    c) and recorded as ``status="failed"`` instead of aborting the whole
    experiment.
    """
    experiment_id = new_experiment_id()
    ledger.record_experiment(experiment_id, spec.metadata.name, spec.to_dict(), "running")

    tasks = select_tasks(task_source, spec)
    matrix = build_matrix(spec, tasks, experiment_id)

    trials: list[TrialRecord] = []
    for planned in matrix:
        try:
            trial = run_trial(
                planned.task,
                planned.agent_ref,
                planned.seed,
                pipeline_fn=pipeline_fn,
                verifier_runner=verifier_runner,
                ledger=ledger,
                experiment_id=experiment_id,
            )
        except Exception as exc:  # noqa: BLE001 - ruling (c): keep the experiment going
            trial = _failed_trial_record(planned, experiment_id, exc)
            ledger.record_trial(trial)
        trials.append(trial)

    result = assemble_result(spec, trials, tasks=tasks, task_source=task_source)
    ledger.update_experiment_result(experiment_id, "completed", result)
    return result


# --------------------------------------------------------------------------
# Metric extraction (NaN guard -- ruling b)
# --------------------------------------------------------------------------


def _sanitize_metric(raw: Any) -> tuple[float, bool]:
    """(value, degraded). Missing/non-numeric/NaN all sanitize to 0.0 and
    ``degraded=True`` -- ruling (b)'s guard at the metric-collection
    boundary, so NaN is NEVER passed into :func:`~.statistics.analyze`."""
    if raw is None:
        return 0.0, True
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return 0.0, True
    if math.isnan(value):
        return 0.0, True
    return value, False


def _primary_value(spec: ExperimentSpec, trial: TrialRecord) -> tuple[float, bool]:
    if spec.metrics.primary == "task_success":
        raw = trial.evaluation.get("f2p_rate")
    else:
        raw = trial.metrics.get(spec.metrics.primary)
    return _sanitize_metric(raw)


def _secondary_value(trial: TrialRecord, name: str) -> tuple[float, bool]:
    return _sanitize_metric(trial.metrics.get(name))


def _metric_or_zero(trial: TrialRecord, name: str) -> float:
    """Like :func:`_sanitize_metric` but never contributes to the degraded
    count -- used for cost/tokens, which is not one of ``spec.metrics``."""
    value, _degraded = _sanitize_metric(trial.metrics.get(name))
    return value


def _trial_is_degraded(spec: ExperimentSpec, trial: TrialRecord) -> bool:
    _, bad = _primary_value(spec, trial)
    if bad:
        return True
    for name in spec.metrics.secondary:
        _, bad = _secondary_value(trial, name)
        if bad:
            return True
    return False


def _has_integrity_violation(integrity: IntegrityFlags) -> bool:
    return bool(
        integrity.verifier_input_violation
        or integrity.denied_action_violation
        or integrity.scope_violation
        or integrity.change_limit_violation
    )


def _series_by_task(
    trials: list[TrialRecord], agent_ref: str, value_fn: Callable[[TrialRecord], float]
) -> dict[str, list[float]]:
    series: dict[str, list[float]] = {}
    for t in trials:
        if t.agent_ref != agent_ref:
            continue
        series.setdefault(t.task.name, []).append(value_fn(t))
    return series


def _relative_cost_delta(
    baseline: Mapping[str, list[float]], candidate: Mapping[str, list[float]]
) -> float:
    """(candidate mean tokens - baseline mean tokens) / baseline mean tokens.

    0.0 when either side has no observations, or the baseline mean is 0
    (nothing to be relative to; matches -- rather than divides by zero).
    """
    baseline_vals = [v for values in baseline.values() for v in values]
    candidate_vals = [v for values in candidate.values() for v in values]
    if not baseline_vals or not candidate_vals:
        return 0.0
    baseline_mean = fmean(baseline_vals)
    if baseline_mean == 0:
        return 0.0
    candidate_mean = fmean(candidate_vals)
    return (candidate_mean - baseline_mean) / baseline_mean


# --------------------------------------------------------------------------
# Result assembly
# --------------------------------------------------------------------------


def _build_per_family(
    spec: ExperimentSpec, trials: list[TrialRecord], family_by_name: dict[str, str]
) -> dict[str, dict[str, Any]]:
    families = sorted(set(family_by_name.values()))
    per_family: dict[str, dict[str, Any]] = {}
    for family in families:
        names = {n for n, f in family_by_name.items() if f == family}
        baseline_vals = [
            _primary_value(spec, t)[0]
            for t in trials
            if t.agent_ref == spec.baseline and t.task.name in names
        ]
        candidate_means: dict[str, float] = {}
        for cand in spec.candidates:
            cand_vals = [
                _primary_value(spec, t)[0]
                for t in trials
                if t.agent_ref == cand and t.task.name in names
            ]
            candidate_means[cand] = fmean(cand_vals) if cand_vals else 0.0
        per_family[family] = {
            "baselineMean": fmean(baseline_vals) if baseline_vals else 0.0,
            "candidateMeans": candidate_means,
        }
    return per_family


def _joint_pass(nochange_trials: list[TrialRecord], fix_trials: list[TrialRecord]) -> bool:
    """Paired-task joint score: the no-change trial(s) must show
    ``p2p_rate == 1.0`` AND ``changed_files == 0``, and the fix trial(s)
    must show ``f2p_rate == 1.0``. Missing either side (a dropped/unpaired
    paired task, or an arm with no matching trial) fails closed."""
    if not nochange_trials or not fix_trials:
        return False
    nochange_ok = all(
        t.evaluation.get("p2p_rate") == 1.0 and t.metrics.get("changed_files") == 0.0
        for t in nochange_trials
    )
    fix_ok = all(t.evaluation.get("f2p_rate") == 1.0 for t in fix_trials)
    return nochange_ok and fix_ok


def _build_paired_task_pairs(
    spec: ExperimentSpec,
    tasks: list[LoadedTask],
    task_source: TaskSource,
    trials: list[TrialRecord],
) -> list[dict[str, Any]]:
    """Joint scoring: score only complete no-change/fix task pairs (both
    the no-change task and its fix sibling present in the selection);
    an incomplete pair (the sibling dropped by the holdout guard, or by
    whatever filtered the selection) is still surfaced, marked
    ``"incomplete": true``, never silently scored.

    Looks up the full (unfiltered) task source, not just the selection, so an
    incomplete pair is detected from EITHER side (a selected no-change
    task whose fix sibling got dropped, or vice versa).
    """
    selected_by_name = {s.spec.metadata.name: s for s in tasks}
    selected_names = set(selected_by_name)
    all_by_name = {s.spec.metadata.name: s for s in task_source.list()}

    pair_names: set[tuple[str, str]] = set()
    for name, task in all_by_name.items():
        paired_task = task.spec.metadata.paired_task
        if paired_task is None:
            continue
        if name in selected_names or paired_task in selected_names:
            pair_names.add((name, paired_task))

    arms = ["baseline", *spec.candidates]

    paired_task_pairs: list[dict[str, Any]] = []
    for nochange_name, fix_name in sorted(pair_names):
        nochange = selected_by_name.get(nochange_name) or all_by_name.get(nochange_name)
        fix = selected_by_name.get(fix_name) or all_by_name.get(fix_name)
        complete = nochange_name in selected_names and fix_name in selected_names

        entry: dict[str, Any] = {
            "noChange": nochange.ref if nochange else nochange_name,
            "fix": fix.ref if fix else fix_name,
        }
        if not complete:
            entry["incomplete"] = True
            paired_task_pairs.append(entry)
            continue

        joint_pass: dict[str, bool] = {}
        for arm in arms:
            agent_ref = spec.baseline if arm == "baseline" else arm
            nochange_trials = [
                t for t in trials if t.agent_ref == agent_ref and t.task.name == nochange_name
            ]
            fix_trials = [t for t in trials if t.agent_ref == agent_ref and t.task.name == fix_name]
            joint_pass[arm] = _joint_pass(nochange_trials, fix_trials)
        entry["jointPass"] = joint_pass
        paired_task_pairs.append(entry)
    return paired_task_pairs


def _build_comparison(spec: ExperimentSpec, trials: list[TrialRecord]) -> dict[str, Any]:
    comparison: dict[str, Any] = {}
    baseline_primary = _series_by_task(trials, spec.baseline, lambda t: _primary_value(spec, t)[0])
    baseline_tokens = _series_by_task(trials, spec.baseline, lambda t: _metric_or_zero(t, "tokens"))

    for cand in spec.candidates:
        cand_primary = _series_by_task(trials, cand, lambda t: _primary_value(spec, t)[0])
        cand_tokens = _series_by_task(trials, cand, lambda t: _metric_or_zero(t, "tokens"))
        cost_delta = _relative_cost_delta(baseline_tokens, cand_tokens)

        analysis = analyze(
            baseline_primary,
            cand_primary,
            tie_zone=spec.decision.tie_zone,
            confidence=spec.decision.confidence,
            cost_delta=cost_delta,
            cost_tiebreak=spec.decision.cost_tiebreak,
        )

        secondary: dict[str, dict[str, float]] = {}
        for metric in spec.metrics.secondary:

            def _value(t: TrialRecord, m: str = metric) -> float:
                return _secondary_value(t, m)[0]

            baseline_m = _series_by_task(trials, spec.baseline, _value)
            cand_m = _series_by_task(trials, cand, _value)
            deltas = task_deltas(baseline_m, cand_m)
            secondary[metric] = {"meanDelta": fmean(deltas.values()) if deltas else 0.0}

        safety_regressions = sum(
            int((t.evaluation.get("scorecard") or {}).get("safety_regressions", 0) or 0)
            for t in trials
            if t.agent_ref == cand
        )
        integrity_violations = sum(
            1 for t in trials if t.agent_ref == cand and _has_integrity_violation(t.integrity)
        )
        eligible = (
            safety_regressions <= spec.hard_gates.safety_regressions
            and integrity_violations <= spec.hard_gates.integrity_violations
            and analysis.verdict == "candidate"
        )

        comparison[cand] = {
            "primary": {
                "meanDelta": analysis.mean_delta,
                "ciLow": analysis.ci_low,
                "ciHigh": analysis.ci_high,
                "wins": analysis.wins,
                "losses": analysis.losses,
                "ties": analysis.ties,
                "verdict": analysis.verdict,
            },
            "secondary": secondary,
            "costDelta": cost_delta,
            "hardGates": {
                "safetyRegressions": safety_regressions,
                "integrityViolations": integrity_violations,
            },
            "eligibleForPromotion": eligible,
        }
    return comparison


def assemble_result(
    spec: ExperimentSpec,
    trials: list[TrialRecord],
    *,
    tasks: list[LoadedTask],
    task_source: TaskSource,
) -> dict[str, Any]:
    """Assemble the experiment result dict (brief's exact shape, plus the
    controller-ruling additions: ``degradedTrials`` (ruling b) and
    ``pairedTaskPairs[*].incomplete`` (ruling a)).

    ``tasks`` (the selection ``run_experiment`` built the matrix from)
    and ``task_source`` (the full, unfiltered task set) are required to
    resolve task family/paired task metadata, which lives on
    :class:`~bakudo.tasks.source.LoadedTask`, not on
    :class:`~bakudo.trials.models.TrialRecord`.
    """
    experiment_id = next((t.experiment_id for t in trials if t.experiment_id), "")
    profile = not spec.candidates

    task_pins = [task.pin.model_dump(mode="json") for task in tasks]
    family_by_name = {s.spec.metadata.name: s.spec.metadata.family.value for s in tasks}

    degraded_trials = sum(
        1 for t in trials if t.status == "completed" and _trial_is_degraded(spec, t)
    )

    result: dict[str, Any] = {
        "experimentId": experiment_id,
        "corpus": {
            "sourceURI": task_source.source_uri,
            "revision": task_source.corpus_revision,
            "tasks": task_pins,
        },
        "usedHoldout": spec.use_holdout,
        "profile": profile,
        "baseline": spec.baseline,
        "candidates": list(spec.candidates),
        "perFamily": _build_per_family(spec, trials, family_by_name),
        "pairedTaskPairs": _build_paired_task_pairs(spec, tasks, task_source, trials),
        "degradedTrials": degraded_trials,
    }

    if not profile:
        result["comparison"] = _build_comparison(spec, trials)

    return result
