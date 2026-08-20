"""Render a persisted PerformanceComparison as a PR-ready evidence block.

The renderer only restates what the immutable record already proves — verdict,
per-metric effects with confidence intervals, and every pin the evidence binds
to — so a reviewer can audit the claim without ledger access. It never
recomputes statistics.
"""

from __future__ import annotations

from .models import MetricComparison, PerformanceComparison


def _percent(value: float | None) -> str:
    return "n/a" if value is None else f"{value * 100:+.2f}%"


def _metric_row(metric: MetricComparison, primary: str) -> str:
    role = "primary" if metric.metric_name == primary else "protected"
    interval = (
        f"[{_percent(metric.ci_lower)}, {_percent(metric.ci_upper)}]"
        if metric.ci_lower is not None and metric.ci_upper is not None
        else "n/a"
    )
    return (
        f"| `{metric.metric_name}` | {role} | {metric.verdict.value} "
        f"| {_percent(metric.relative_effect)} | {interval} "
        f"| {metric.practical_threshold * 100:.1f}% | {metric.sample_count} |"
    )


def comparison_markdown(comparison: PerformanceComparison) -> str:
    workload = comparison.workload
    environment = comparison.baseline_environment
    integrity = "valid" if comparison.integrity.valid else "VIOLATED"
    lines = [
        "## Trusted performance comparison",
        "",
        f"**Verdict: {comparison.verdict.value}** — "
        f"{'eligible' if comparison.eligible else 'NOT eligible'} as optimization evidence "
        f"(status {comparison.status.value}, integrity {integrity})",
        "",
        f"- Workload: `{workload.name}@{workload.version}` (bundle `{workload.bundle_digest}`)",
        f"- Repository: `{comparison.baseline_revision.repository}` — "
        f"baseline `{comparison.baseline_revision.commit_sha}`, "
        f"candidate `{comparison.candidate_revision.commit_sha}`",
        f"- Environment: `{environment.environment_digest}` "
        f"(profile {environment.profile}, {environment.cpu_count} vCPU / "
        f"{environment.memory_mb} MiB, abox {environment.abox_version})",
        f"- Analysis: {comparison.confidence:.0%} confidence, "
        f"{comparison.bootstrap_resamples} bootstrap resamples, "
        f"seed {comparison.analysis_seed}",
        "",
        "| Metric | Role | Verdict | Relative effect | CI | Threshold | Samples |",
        "|---|---|---|---|---|---|---|",
    ]
    ordered = sorted(
        comparison.metrics, key=lambda metric: metric.metric_name != comparison.primary_metric
    )
    lines.extend(_metric_row(metric, comparison.primary_metric) for metric in ordered)
    lines.extend(
        [
            "",
            f"Comparison `{comparison.id}` "
            f"(measurements `{comparison.baseline_measurement_id}` / "
            f"`{comparison.candidate_measurement_id}`).",
        ]
    )
    if comparison.incompatibilities:
        lines.append("")
        lines.append("**Incompatibilities:** " + "; ".join(comparison.incompatibilities))
    return "\n".join(lines) + "\n"
