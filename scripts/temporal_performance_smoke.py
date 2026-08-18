"""Run the performance workflows against an explicitly configured Temporal cluster.

This live smoke uses injected deterministic invocations, so it verifies durable
serialization, activities, child-workflow fan-out, persistence, and analysis
without requiring KVM or executing target repository code.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from typing import Any

from temporalio.client import Client
from temporalio.worker import Worker

from bakudo.performance.models import (
    InvocationOutcome,
    InvocationPhase,
    MetricUnit,
    MetricValue,
    RecordStatus,
)
from bakudo.performance.pins import EnvironmentPin, RevisionPin
from bakudo.performance.source import default_workload_source
from bakudo.registry import InMemoryLedger
from bakudo.temporal import _impl
from bakudo.temporal.activities import (
    analyze_artifact_experiment,
    persist_experiment,
    prepare_artifact_experiment,
    run_performance_comparison,
    run_performance_measurement,
)
from bakudo.temporal.shared import (
    ExperimentInput,
    PerformanceComparisonInput,
    PerformanceMeasurementInput,
)
from bakudo.temporal.workflows import (
    ExperimentWorkflow,
    PerformanceComparisonWorkflow,
    PerformanceMeasurementWorkflow,
)

_DIGEST = "sha256:" + "a" * 64


class _Invoker:
    def invoke(
        self,
        workload: Any,
        revision: RevisionPin,
        environment: EnvironmentPin,
        *,
        phase: InvocationPhase,
        ordinal: int,
    ) -> InvocationOutcome:
        del environment
        definition = workload.spec.measurement.metrics[0]
        value = 10.0 if revision.commit_sha.startswith("a") else 5.0
        return InvocationOutcome(
            ordinal=ordinal,
            phase=phase,
            status=RecordStatus.completed,
            exit_code=0,
            metrics=(
                MetricValue(
                    name=definition.name,
                    unit=MetricUnit(definition.unit.value),
                    value=value,
                ),
            ),
        )


def _revision(value: str) -> RevisionPin:
    return RevisionPin(
        repository="bakudo-smoke",
        source_uri="file:///tmp/bakudo-live-smoke",
        commit_sha=value * 40,
        tree_digest="sha256:" + value * 64,
    )


def _environment() -> EnvironmentPin:
    return EnvironmentPin(
        bakudo_version="3.0.0",
        abox_version="0.7.1",
        image_digest=_DIGEST,
        profile="python-glibc",
        hardware_class="temporal-smoke",
        architecture="arm64",
        cpu_count=1,
        memory_mb=256,
        os="linux",
        kernel="synthetic",
        dependency_lock_digest=_DIGEST,
        environment_digest=_DIGEST,
    )


def _document(value: Any) -> dict[str, Any]:
    return value.model_dump(by_alias=True, exclude_none=True, mode="json")


async def _run(address: str, namespace: str) -> dict[str, Any]:
    client = await Client.connect(address, namespace=namespace)
    queue = f"bakudo-performance-live-{uuid.uuid4().hex}"
    suffix = uuid.uuid4().hex
    source = default_workload_source()
    workload = source.load("smoke-python-loop@1.0.0")
    environment = _environment()
    baseline = _revision("a")
    candidate = _revision("b")
    ledger = InMemoryLedger()

    original_deps = _impl.DEPS
    original_environment_loader = _impl.configured_environment_pin
    _impl.DEPS = _impl.Deps(
        ledger=ledger,
        performance_workload_source_fn=lambda: source,
        performance_invoker=_Invoker(),
    )
    _impl.configured_environment_pin = lambda: environment
    executor = ThreadPoolExecutor(max_workers=4, thread_name_prefix="temporal-live")
    try:
        async with Worker(
            client,
            task_queue=queue,
            workflows=[
                PerformanceMeasurementWorkflow,
                PerformanceComparisonWorkflow,
                ExperimentWorkflow,
            ],
            activities=[
                run_performance_measurement,
                run_performance_comparison,
                prepare_artifact_experiment,
                analyze_artifact_experiment,
                persist_experiment,
            ],
            activity_executor=executor,
        ):
            common = {
                "workload": workload.ref,
                "environment": _document(environment),
                "workload_source": "package://bakudo/smoke-workloads",
                "workload_pin": _document(workload.pin),
            }
            measurement = await client.execute_workflow(
                PerformanceMeasurementWorkflow.run,
                PerformanceMeasurementInput(
                    operation_id=f"live-measure-{suffix}",
                    revision=_document(baseline),
                    **common,
                ),
                id=f"bakudo-live-measure-{suffix}",
                task_queue=queue,
                execution_timeout=timedelta(minutes=3),
            )
            comparison = await client.execute_workflow(
                PerformanceComparisonWorkflow.run,
                PerformanceComparisonInput(
                    operation_id=f"live-compare-{suffix}",
                    workload=workload.ref,
                    baseline_revision=_document(baseline),
                    candidate_revision=_document(candidate),
                    baseline_environment=_document(environment),
                    candidate_environment=_document(environment),
                    workload_source="package://bakudo/smoke-workloads",
                    workload_pin=_document(workload.pin),
                    seed=17,
                    bootstrap_resamples=100,
                ),
                id=f"bakudo-live-compare-{suffix}",
                task_queue=queue,
                execution_timeout=timedelta(minutes=3),
            )
            experiment = await client.execute_workflow(
                ExperimentWorkflow.run,
                ExperimentInput(
                    spec={
                        "apiVersion": "bakudo.ai/v1alpha1",
                        "kind": "ExperimentSpec",
                        "metadata": {"name": f"live-artifact-{suffix}"},
                        "subject": {
                            "kind": "software-artifact",
                            "repository": "bakudo-smoke",
                            "baseline": _document(baseline),
                            "candidates": [_document(candidate)],
                            "workloadRef": {
                                "name": workload.pin.name,
                                "version": workload.pin.version,
                                "source": "directory",
                            },
                        },
                        "metrics": {"primary": "latency_seconds"},
                        "decision": {"bootstrapResamples": 100},
                    }
                ),
                id=f"bakudo-live-experiment-{suffix}",
                task_queue=queue,
                execution_timeout=timedelta(minutes=3),
            )
    finally:
        executor.shutdown(wait=True)
        _impl.DEPS = original_deps
        _impl.configured_environment_pin = original_environment_loader

    if measurement.status != "completed" or measurement.record_id is None:
        raise RuntimeError(f"measurement smoke failed: {measurement}")
    if comparison.status != "completed" or comparison.record_id is None:
        raise RuntimeError(f"comparison smoke failed: {comparison}")
    if experiment.get("subjectKind") != "software-artifact":
        raise RuntimeError(f"artifact experiment smoke failed: {experiment}")
    return {
        "address": address,
        "namespace": namespace,
        "taskQueue": queue,
        "measurement": measurement.record_id,
        "comparison": comparison.record_id,
        "experiment": experiment["experimentId"],
        "artifactVerdict": experiment["comparison"]["candidate-1"]["primary"][
            "verdict"
        ],
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--address", required=True)
    parser.add_argument("--namespace", default="default")
    args = parser.parse_args()
    print(json.dumps(asyncio.run(_run(args.address, args.namespace)), indent=2))


if __name__ == "__main__":
    main()
