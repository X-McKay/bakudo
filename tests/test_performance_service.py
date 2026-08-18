from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from bakudo.observability import FakeSpanSink, SpanName
from bakudo.performance.measurement import ComparisonSide, build_comparison_schedule
from bakudo.performance.models import (
    InvocationOutcome,
    InvocationPhase,
    MetricValue,
    RecordStatus,
    Verdict,
)
from bakudo.performance.pins import EnvironmentPin, RevisionPin
from bakudo.performance.service import PerformanceMeasurementService
from bakudo.performance.source import DirectoryWorkloadSource, LoadedWorkload
from bakudo.registry.ledger import InMemoryLedger

_DIGEST = "sha256:" + "a" * 64


def _loaded() -> LoadedWorkload:
    root = Path(__file__).parents[1] / "smoke" / "workloads"
    return DirectoryWorkloadSource(root).load("smoke-python-loop@1.0.0")


def _revision(char: str) -> RevisionPin:
    return RevisionPin(
        repository="bakudo-smoke",
        source_uri="file:///tmp/bakudo-smoke",
        commit_sha=char * 40,
        tree_digest="sha256:" + char * 64,
    )


def _environment(*, profile: str = "python-glibc") -> EnvironmentPin:
    return EnvironmentPin(
        bakudo_version="3.0.0",
        abox_version="0.7.1",
        image_digest=_DIGEST,
        profile=profile,
        hardware_class="test",
        architecture="arm64",
        cpu_count=1,
        memory_mb=256,
        os="linux",
        kernel="test",
        dependency_lock_digest=_DIGEST,
        environment_digest=_DIGEST,
    )


@dataclass(frozen=True)
class _Call:
    revision: str
    phase: InvocationPhase
    ordinal: int


class _Invoker:
    def __init__(self, samples: dict[str, tuple[float, ...]]) -> None:
        self.samples = samples
        self.calls: list[_Call] = []

    def invoke(
        self,
        workload: LoadedWorkload,
        revision: RevisionPin,
        environment: EnvironmentPin,
        *,
        phase: InvocationPhase,
        ordinal: int,
    ) -> InvocationOutcome:
        del environment
        key = revision.commit_sha[0]
        self.calls.append(_Call(key, phase, ordinal))
        value = 0.0 if phase is InvocationPhase.warmup else self.samples[key][ordinal]
        metric = workload.spec.measurement.metrics[0]
        return InvocationOutcome(
            ordinal=ordinal,
            phase=phase,
            status=RecordStatus.completed,
            elapsed_seconds=value,
            exit_code=0,
            metrics=(MetricValue(name=metric.name, unit=metric.unit, value=value),),
        )


def test_compare_interleaves_sides_and_persists_independent_evidence() -> None:
    loaded = _loaded()
    invoker = _Invoker({"a": (10.0,) * 6, "b": (5.0,) * 6})
    ledger = InMemoryLedger()
    spans = FakeSpanSink()
    service = PerformanceMeasurementService(invoker, ledger=ledger, span_sink=spans)

    result = service.compare(
        loaded,
        _revision("a"),
        _revision("b"),
        _environment(),
        _environment(),
        seed=17,
        bootstrap_resamples=100,
        comparison_id="comparison_" + "2" * 26,
    )

    schedule = build_comparison_schedule(loaded.spec.measurement, seed=17)
    expected = [
        _Call(
            "a" if item.side is ComparisonSide.baseline else "b",
            InvocationPhase(item.phase.value),
            item.pair_index,
        )
        for item in schedule
    ]
    assert invoker.calls == expected
    assert result.baseline.status is RecordStatus.completed
    assert result.candidate.status is RecordStatus.completed
    assert result.comparison.verdict is Verdict.improved
    assert result.comparison.eligible
    assert result.comparison.id == "comparison_" + "2" * 26
    assert ledger.get_measurement(result.baseline.id) == result.baseline
    assert ledger.get_measurement(result.candidate.id) == result.candidate
    assert ledger.get_performance_comparison(result.comparison.id) == result.comparison
    assert [record.name for record in spans.records].count(SpanName.PERFORMANCE_MEASURE) == 1
    assert [record.name for record in spans.records].count(SpanName.STATISTICS_ANALYZE) == 1
    assert [record.name for record in spans.records].count(SpanName.LEDGER_PERSIST) == 3


def test_measure_rejects_environment_before_invocation_and_persists_reason() -> None:
    invoker = _Invoker({"a": (10.0,) * 6})
    ledger = InMemoryLedger()
    result = PerformanceMeasurementService(invoker, ledger=ledger).measure(
        _loaded(),
        _revision("a"),
        _environment(profile="wrong-profile"),
    )

    assert result.status is RecordStatus.incompatible_environment
    assert not result.integrity.valid
    assert result.failure_reason is not None
    assert invoker.calls == []
    assert ledger.get_measurement(result.id) == result


class _BrokenInvoker:
    def invoke(
        self,
        workload: LoadedWorkload,
        revision: RevisionPin,
        environment: EnvironmentPin,
        *,
        phase: InvocationPhase,
        ordinal: int,
    ) -> InvocationOutcome:
        del workload, revision, environment, phase, ordinal
        raise RuntimeError("untrusted adapter detail")


def test_adapter_failure_becomes_typed_record_without_error_text() -> None:
    result = PerformanceMeasurementService(_BrokenInvoker()).measure(
        _loaded(), _revision("a"), _environment()
    )

    assert result.status is RecordStatus.failed
    assert result.failure_reason is not None
    assert result.stderr == ""
    assert all(outcome.status is RecordStatus.failed for outcome in result.warmups)
    assert all(outcome.status is RecordStatus.failed for outcome in result.invocations)
