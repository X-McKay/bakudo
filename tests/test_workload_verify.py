from __future__ import annotations

from pathlib import Path

import yaml

from bakudo.performance.models import WorkloadSpec
from bakudo.performance.verify import (
    WorkloadVerificationPolicy,
    verify_and_pin_workload,
    workload_content_digest,
)
from test_workload_source import make_workload


def _spec(path: Path) -> WorkloadSpec:
    return WorkloadSpec.model_validate(yaml.safe_load((path / "workload.yaml").read_text()))


def test_verification_pin_is_stable_and_content_sensitive(tmp_path: Path) -> None:
    root = tmp_path / "workloads"
    root.mkdir()
    workload = make_workload(root)
    spec = _spec(workload)
    first = verify_and_pin_workload(
        workload,
        spec,
        source_uri=root.as_uri(),
        source_kind="directory",
        collection_revision="r1",
    )
    second = verify_and_pin_workload(
        workload,
        spec,
        source_uri=root.as_uri(),
        source_kind="directory",
        collection_revision="r1",
    )
    assert first.ok and first.pin == second.pin
    assert first.pin is not None
    assert first.pin.bundle_digest == workload_content_digest(workload)

    (workload / "run.py").write_text("print('changed')\n")
    changed = verify_and_pin_workload(
        workload,
        spec,
        source_uri=root.as_uri(),
        source_kind="directory",
        collection_revision="r1",
    )
    assert changed.ok and changed.pin is not None
    assert changed.pin.bundle_digest != first.pin.bundle_digest
    assert changed.pin.executor_digests != first.pin.executor_digests


def test_content_digest_golden_value_is_stable(tmp_path: Path) -> None:
    """The digest algorithm is pinned identity: this golden value was
    computed before executable-awareness landed and must never change for
    workloads without executables, or every persisted pin breaks."""
    root = tmp_path / "w"
    (root / "data").mkdir(parents=True)
    (root / "run.py").write_bytes(b"print('golden')\n")
    (root / "data" / "input.json").write_bytes(b'{"n": 1}\n')

    assert (
        workload_content_digest(root)
        == "sha256:852359eb8d24662f40cad36aa58a9137d0dddd973a256253c7ce33a05163aa7b"
    )


def test_executable_bit_is_part_of_content_identity(tmp_path: Path) -> None:
    """The runners restore +x in-guest, so the bit changes behavior and must
    change identity — same bytes, different mode, different digest."""
    root = tmp_path / "w"
    root.mkdir()
    tool = root / "tool.sh"
    tool.write_bytes(b"#!/bin/sh\nexit 0\n")
    baseline = workload_content_digest(root)

    tool.chmod(0o755)
    with_exec = workload_content_digest(root)
    assert with_exec != baseline

    tool.chmod(0o644)
    assert workload_content_digest(root) == baseline


def test_bytecode_caches_never_enter_the_content_digest(tmp_path: Path) -> None:
    """pip byte-compiles packaged corpora on install; those cache files must
    not make a wheel install's digest diverge from the source checkout's."""
    root = tmp_path / "workloads"
    root.mkdir()
    workload = make_workload(root)
    pristine = workload_content_digest(workload)

    cache = workload / "__pycache__"
    cache.mkdir()
    (cache / "run.cpython-311.pyc").write_bytes(b"\x00compiled")
    (workload / "run.pyc").write_bytes(b"\x00compiled")

    assert workload_content_digest(workload) == pristine


def test_environment_cannot_widen_selected_posture(tmp_path: Path) -> None:
    root = tmp_path / "workloads"
    root.mkdir()
    workload = make_workload(root)
    document = yaml.safe_load((workload / "workload.yaml").read_text())
    document["environment"].update({"network": "scoped", "cpuCount": 8, "memoryMb": 4096})
    spec = WorkloadSpec.model_validate(document)
    report = verify_and_pin_workload(
        workload,
        spec,
        source_uri=root.as_uri(),
        source_kind="directory",
        collection_revision="r1",
        policy=WorkloadVerificationPolicy(
            selected_profile="python-small",
            allow_scoped_network=False,
            max_cpu_count=2,
            max_memory_mb=512,
        ),
    )
    assert not report.ok
    assert report.pin is None
    assert [issue.path for issue in report.issues] == [
        "/environment/network",
        "/environment/cpuCount",
        "/environment/memoryMb",
    ]


def test_unsupported_metric_source_is_reported_precisely(tmp_path: Path) -> None:
    root = tmp_path / "workloads"
    root.mkdir()
    workload = make_workload(root)
    report = verify_and_pin_workload(
        workload,
        _spec(workload),
        source_uri=root.as_uri(),
        source_kind="directory",
        collection_revision="r1",
        policy=WorkloadVerificationPolicy(supported_metric_sources=()),
    )
    assert not report.ok
    assert report.issues[0].path == "/measurement/metrics/0/source"


def test_installed_profiler_option_schema_is_enforced(tmp_path: Path) -> None:
    root = tmp_path / "workloads"
    root.mkdir()
    workload = make_workload(root)
    document = yaml.safe_load((workload / "workload.yaml").read_text())
    document["profilers"] = [
        {
            "name": "synthetic",
            "adapter": "synthetic",
            "signals": ["cpu-samples"],
            "options": {"samplingHz": 0},
        }
    ]
    spec = WorkloadSpec.model_validate(document)

    def validate_options(options):
        if options.get("samplingHz", 0) < 1:
            raise ValueError("samplingHz must be positive")

    report = verify_and_pin_workload(
        workload,
        spec,
        source_uri=root.as_uri(),
        source_kind="directory",
        collection_revision="r1",
        policy=WorkloadVerificationPolicy(
            profiler_option_validators={"synthetic": validate_options}
        ),
    )
    assert not report.ok
    assert report.issues[-1].path == "/profilers/0/options"


def test_environment_values_are_allowlisted(tmp_path: Path) -> None:
    root = tmp_path / "workloads"
    root.mkdir()
    workload = make_workload(root)
    document = yaml.safe_load((workload / "workload.yaml").read_text())
    document["command"]["env"] = {"LD_PRELOAD": "/tmp/untrusted.so"}
    spec = WorkloadSpec.model_validate(document)
    report = verify_and_pin_workload(
        workload,
        spec,
        source_uri=root.as_uri(),
        source_kind="directory",
        collection_revision="r1",
    )
    assert not report.ok
    assert report.issues[0].path == "/command/env/LD_PRELOAD"
