from __future__ import annotations

from bakudo.performance.models import (
    Hotspot,
    IntegrityResult,
    MeasurementRecord,
    MetricComparison,
    MetricDirection,
    MetricEstimator,
    MetricSampleSet,
    MetricUnit,
    PerformanceComparison,
    PerformanceRegressionSignal,
    PerformanceSnapshot,
    ProfilerDescriptor,
    RecordStatus,
    Verdict,
    WorkloadSpec,
)
from bakudo.performance.pins import EnvironmentPin, RevisionPin, WorkloadPin
from bakudo.registry import InMemoryLedger
from bakudo.registry.postgres_ledger import PostgresLedger

DIGEST = "sha256:" + "a" * 64


def _workload() -> WorkloadSpec:
    return WorkloadSpec.model_validate(
        {
            "metadata": {"name": "latency-smoke", "version": "1.0.0"},
            "subject": {"repo": "demo"},
            "command": {"argv": ["python", "bench.py"]},
            "environment": {"profile": "python-small"},
            "measurement": {
                "repetitions": 3,
                "timeoutSeconds": 30,
                "metrics": [
                    {
                        "name": "latency_seconds",
                        "unit": "seconds",
                        "direction": "lower",
                        "source": "wall-clock",
                    }
                ],
            },
        }
    )


def _workload_pin() -> WorkloadPin:
    return WorkloadPin(
        source_uri="file:///workloads",
        source_kind="directory",
        collection_revision="main",
        name="latency-smoke",
        version="1.0.0",
        manifest_digest=DIGEST,
        bundle_digest=DIGEST,
    )


def _revision(commit: str) -> RevisionPin:
    return RevisionPin(
        repository="demo",
        source_uri="file:///demo",
        commit_sha=commit,
        tree_digest=DIGEST,
    )


def _environment() -> EnvironmentPin:
    return EnvironmentPin(
        bakudo_version="3.0.0",
        abox_version="0.7.1",
        image_digest=DIGEST,
        profile="python-small",
        hardware_class="test",
        architecture="arm64",
        cpu_count=2,
        memory_mb=1024,
        os="darwin",
        kernel="test",
        dependency_lock_digest=DIGEST,
        environment_digest=DIGEST,
    )


def _samples(summary: float) -> MetricSampleSet:
    return MetricSampleSet(
        metric_name="latency_seconds",
        unit=MetricUnit.seconds,
        direction=MetricDirection.lower_is_better,
        estimator=MetricEstimator.median,
        samples=(summary - 0.1, summary, summary + 0.1),
        summary=summary,
        dispersion=0.1,
        valid=True,
    )


def _measurement(commit: str, summary: float) -> MeasurementRecord:
    return MeasurementRecord(
        workload=_workload_pin(),
        revision=_revision(commit),
        environment=_environment(),
        plan_digest=DIGEST,
        metrics=(_samples(summary),),
        status=RecordStatus.completed,
    )


def test_in_memory_performance_records_are_idempotent_and_filterable() -> None:
    ledger = InMemoryLedger()
    spec = _workload()
    pin = _workload_pin()
    baseline = _measurement("1" * 40, 10.0)
    candidate = _measurement("2" * 40, 7.0)

    ledger.record_workload_version(spec, pin)
    ledger.record_workload_version(spec, pin)
    ledger.record_measurement(baseline)
    ledger.record_measurement(baseline)
    ledger.record_measurement(candidate)

    assert ledger.get_workload_version(spec.ref) == {
        "spec": spec.to_dict(),
        "pin": pin.model_dump(by_alias=True, mode="json"),
    }
    assert ledger.get_measurement(baseline.id) == baseline
    assert ledger.list_measurements("demo", spec.ref) == [baseline, candidate]
    assert ledger.list_measurements("other") == []


def test_in_memory_snapshot_comparison_and_regression_round_trip() -> None:
    ledger = InMemoryLedger()
    baseline = _measurement("1" * 40, 10.0)
    candidate = _measurement("2" * 40, 7.0)
    snapshot = PerformanceSnapshot(
        workload=_workload_pin(),
        revision=baseline.revision,
        environment=_environment().model_copy(
            update={"profiler_adapter": "synthetic", "profiler_version": "1"}
        ),
        profiler_spec_digest=DIGEST,
        descriptor=ProfilerDescriptor(
            name="synthetic", adapter="synthetic", version="1"
        ),
        capture_seconds=1.0,
        hotspots=(
            Hotspot(
                kind="function",
                stable_key="bench.py:work",
                label="work",
                source_path="bench.py",
                source_line=1,
                inclusive_cost=0.8,
                sample_count=80,
                percentage=80,
            ),
        ),
        sanitization_status="sanitized",
        status=RecordStatus.completed,
    )
    metric = MetricComparison(
        metric_name="latency_seconds",
        unit=MetricUnit.seconds,
        direction=MetricDirection.lower_is_better,
        estimator=MetricEstimator.median,
        baseline_summary=10.0,
        candidate_summary=7.0,
        absolute_effect=3.0,
        relative_effect=0.3,
        ci_lower=0.2,
        ci_upper=0.4,
        practical_threshold=0.05,
        sample_count=3,
        verdict=Verdict.improved,
        valid=True,
    )
    comparison = PerformanceComparison(
        workload=_workload_pin(),
        baseline_revision=baseline.revision,
        candidate_revision=candidate.revision,
        baseline_environment=baseline.environment,
        candidate_environment=candidate.environment,
        baseline_measurement_id=baseline.id,
        candidate_measurement_id=candidate.id,
        primary_metric="latency_seconds",
        metrics=(metric,),
        status=RecordStatus.completed,
        verdict=Verdict.improved,
        integrity=IntegrityResult(),
        eligible=True,
        analysis_seed=7,
        confidence=0.95,
        bootstrap_resamples=1_000,
    )
    signal = PerformanceRegressionSignal(
        repository="demo",
        workload=_workload_pin(),
        metric_name="latency_seconds",
        comparison_id=comparison.id,
        relative_regression=0.3,
        confidence=0.95,
        consecutive_observations=2,
        deduplication_key="demo:latency-smoke:latency_seconds",
        approved=True,
    )

    ledger.record_performance_snapshot(snapshot)
    ledger.record_performance_snapshot(snapshot)
    ledger.record_performance_comparison(comparison)
    ledger.record_performance_comparison(comparison)
    ledger.record_performance_regression(signal)
    ledger.record_performance_regression(signal)

    assert ledger.get_performance_snapshot(snapshot.id) == snapshot
    assert ledger.get_performance_comparison(comparison.id) == comparison
    assert ledger.list_performance_comparisons("demo", _workload_pin().ref) == [comparison]
    assert ledger.list_performance_regressions("demo") == [signal]
    assert ledger.list_performance_regressions("other") == []


def test_workload_version_collision_fails_closed() -> None:
    ledger = InMemoryLedger()
    spec = _workload()
    ledger.record_workload_version(spec, _workload_pin())

    changed = spec.model_copy(
        update={
            "measurement": spec.measurement.model_copy(update={"warmups": 1})
        }
    )
    try:
        ledger.record_workload_version(changed, _workload_pin())
    except ValueError as exc:
        assert "collision" in str(exc)
    else:
        raise AssertionError("same workload version with changed spec must be rejected")


class _FakeCursor:
    def __init__(self, connection: _FakeConnection) -> None:
        self.connection = connection

    def __enter__(self) -> _FakeCursor:
        return self

    def __exit__(self, *_args: object) -> None:
        return None

    def execute(self, sql: str, params: tuple = ()) -> None:
        self.connection.executed.append((" ".join(sql.split()), params))

    def fetchone(self) -> tuple | None:
        return self.connection.rows.pop(0) if self.connection.rows else None

    def fetchall(self) -> list[tuple]:
        rows, self.connection.rows = self.connection.rows, []
        return rows


class _FakeConnection:
    def __init__(self, rows: list[tuple] | None = None) -> None:
        self.executed: list[tuple[str, tuple]] = []
        self.rows = list(rows or [])

    def cursor(self) -> _FakeCursor:
        return _FakeCursor(self)


def test_postgres_measurement_write_self_migrates_and_is_idempotent() -> None:
    connection = _FakeConnection()
    record = _measurement("1" * 40, 10.0)

    PostgresLedger(connection).record_measurement(record)

    statements = [sql for sql, _ in connection.executed]
    ddl_index = next(
        index
        for index, sql in enumerate(statements)
        if "create table if not exists measurement_records" in sql
    )
    insert_index = next(
        index for index, sql in enumerate(statements) if "insert into measurement_records" in sql
    )
    assert ddl_index < insert_index
    insert_sql, params = connection.executed[insert_index]
    assert "on conflict (id) do nothing" in insert_sql
    assert params[:5] == (
        record.id,
        "demo",
        "latency-smoke@1.0.0",
        "1" * 40,
        "completed",
    )


def test_postgres_measurement_read_and_filters_round_trip_domain_model() -> None:
    record = _measurement("1" * 40, 10.0)
    document = record.to_dict()
    get_connection = _FakeConnection(rows=[(document,)])
    ledger = PostgresLedger(get_connection)

    assert ledger.get_measurement(record.id) == record

    list_connection = _FakeConnection(rows=[(document,)])
    listed = PostgresLedger(list_connection).list_measurements(
        repository="demo", workload_ref="latency-smoke@1.0.0"
    )
    assert listed == [record]
    select_sql, params = list_connection.executed[-1]
    assert "where repository = %s and workload_ref = %s" in select_sql
    assert params == ("demo", "latency-smoke@1.0.0")
