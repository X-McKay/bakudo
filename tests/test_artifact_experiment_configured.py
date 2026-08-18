from pathlib import Path

from fastapi.testclient import TestClient

from bakudo.api.server import build_app
from bakudo.cli import _run_experiment_and_report
from bakudo.control import MetaAgentTools
from bakudo.experiments import configured
from bakudo.experiments.artifact_subject import ArtifactMeasurementRequest
from bakudo.experiments.configured import configured_artifact_measurement_observer
from bakudo.experiments.models import ExperimentSpec
from bakudo.performance.models import (
    InvocationOutcome,
    InvocationPhase,
    MetricUnit,
    MetricValue,
    RecordStatus,
)
from bakudo.performance.pins import EnvironmentPin, RevisionPin
from bakudo.performance.source import DirectoryWorkloadSource
from bakudo.registry import InMemoryLedger

_DIGEST = "sha256:" + "a" * 64


def _revision(value: str) -> RevisionPin:
    return RevisionPin(
        repository="bakudo-smoke",
        source_uri="file:///tmp/bakudo-smoke",
        commit_sha=value * 40,
        tree_digest="sha256:" + value * 64,
    )


def _environment() -> EnvironmentPin:
    return EnvironmentPin(
        bakudo_version="3.0.0",
        abox_version="0.7.2",
        image_digest=_DIGEST,
        profile="python-glibc",
        hardware_class="test",
        architecture="arm64",
        cpu_count=1,
        memory_mb=256,
        os="linux",
        kernel="test",
        dependency_lock_digest=_DIGEST,
        environment_digest=_DIGEST,
    )


class _Invoker:
    def __init__(self) -> None:
        self.calls = 0

    def invoke(
        self,
        workload,
        revision,
        environment,
        *,
        phase: InvocationPhase,
        ordinal: int,
    ) -> InvocationOutcome:
        del workload, environment
        self.calls += 1
        value = 10.0 if revision.commit_sha.startswith("a") else 5.0
        return InvocationOutcome(
            ordinal=ordinal,
            phase=phase,
            status=RecordStatus.completed,
            exit_code=0,
            metrics=(
                MetricValue(
                    name="latency_seconds",
                    unit=MetricUnit.seconds,
                    value=value,
                ),
            ),
        )


def test_configured_observer_is_independently_injectable_and_cell_idempotent() -> None:
    root = Path(__file__).parents[1] / "smoke" / "workloads"
    source = DirectoryWorkloadSource(root)
    spec = ExperimentSpec.model_validate(
        {
            "metadata": {"name": "configured-artifact"},
            "subject": {
                "kind": "software-artifact",
                "repository": "bakudo-smoke",
                "baseline": _revision("a").model_dump(by_alias=True, mode="json"),
                "candidates": [
                    _revision("b").model_dump(by_alias=True, mode="json")
                ],
                "workloadRef": {
                    "name": "smoke-python-loop",
                    "version": "1.0.0",
                    "source": "directory",
                },
            },
            "metrics": {"primary": "latency_seconds"},
            "decision": {"bootstrapResamples": 100},
        }
    )
    ledger = InMemoryLedger()
    invoker = _Invoker()
    observe = configured_artifact_measurement_observer(
        spec,
        ledger=ledger,
        workload_source=source,
        environment=_environment(),
        invoker=invoker,
    )
    request = ArtifactMeasurementRequest(
        experiment_id="exp_00000000000000000000000000",
        repository="bakudo-smoke",
        workload=spec.subject.workload_ref,  # type: ignore[union-attr]
        revision=_revision("a"),
        arm="baseline",
        repetition=0,
        seed=7,
    )

    first = observe(request)
    call_count = invoker.calls
    second = observe(request)

    assert first.id == second  # type: ignore[union-attr]
    assert call_count == 7
    assert invoker.calls == call_count


def test_api_dispatches_artifact_subject_without_agent_sandbox(
    monkeypatch,
) -> None:
    root = Path(__file__).parents[1] / "smoke" / "workloads"
    source = DirectoryWorkloadSource(root)
    environment = _environment()
    invoker = _Invoker()
    original = configured.configured_artifact_measurement_observer

    def factory(spec, *, ledger):
        return original(
            spec,
            ledger=ledger,
            workload_source=source,
            environment=environment,
            invoker=invoker,
        )

    monkeypatch.setattr(configured, "configured_artifact_measurement_observer", factory)
    tools = MetaAgentTools()
    client = TestClient(build_app(tools))
    response = client.post(
        "/experiments",
        json={
            "apiVersion": "bakudo.ai/v1alpha1",
            "kind": "ExperimentSpec",
            "metadata": {"name": "api-artifact"},
            "subject": {
                "kind": "software-artifact",
                "repository": "bakudo-smoke",
                "baseline": _revision("a").model_dump(
                    by_alias=True, exclude_none=True, mode="json"
                ),
                "candidates": [
                    _revision("b").model_dump(
                        by_alias=True, exclude_none=True, mode="json"
                    )
                ],
                "workloadRef": {
                    "name": "smoke-python-loop",
                    "version": "1.0.0",
                    "source": "directory",
                },
            },
            "metrics": {"primary": "latency_seconds"},
            "decision": {"bootstrapResamples": 100},
        },
    )

    assert response.status_code == 200, response.text
    stored = tools.ledger.get_experiment(response.json()["id"])
    assert stored is not None
    assert stored["subject_kind"] == "software-artifact"


def test_cli_dispatches_artifact_subject_without_agent_verifier(
    monkeypatch, capsys
) -> None:
    root = Path(__file__).parents[1] / "smoke" / "workloads"
    source = DirectoryWorkloadSource(root)
    original = configured.configured_artifact_measurement_observer
    spec = ExperimentSpec.model_validate(
        {
            "metadata": {"name": "cli-artifact"},
            "subject": {
                "kind": "software-artifact",
                "repository": "bakudo-smoke",
                "baseline": _revision("a").model_dump(by_alias=True, mode="json"),
                "candidates": [
                    _revision("b").model_dump(by_alias=True, mode="json")
                ],
                "workloadRef": {
                    "name": "smoke-python-loop",
                    "version": "1.0.0",
                    "source": "directory",
                },
            },
            "metrics": {"primary": "latency_seconds"},
            "decision": {"bootstrapResamples": 100},
        }
    )

    def factory(configured_spec, *, ledger):
        return original(
            configured_spec,
            ledger=ledger,
            workload_source=source,
            environment=_environment(),
            invoker=_Invoker(),
        )

    monkeypatch.setattr(configured, "configured_artifact_measurement_observer", factory)

    assert _run_experiment_and_report(spec, True, command_label="experiment run") == 0
    output = capsys.readouterr().out
    assert '"subjectKind": "software-artifact"' in output
