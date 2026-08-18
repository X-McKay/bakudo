from __future__ import annotations

import pytest
from pydantic import ValidationError

from bakudo.performance.compatibility import (
    CompatibilityPolicy,
    compare_environment_pins,
    compare_workload_pins,
)
from bakudo.performance.pins import EnvironmentPin, FileDigest, RevisionPin, WorkloadPin

DIGEST = "sha256:" + "0" * 64


def _workload(**changes) -> WorkloadPin:
    data = {
        "sourceURI": "file:///workloads",
        "sourceKind": "directory",
        "collectionRevision": "r1",
        "name": "loop",
        "version": "1.0.0",
        "manifestDigest": DIGEST,
        "datasetDigests": [{"path": "data.json", "digest": DIGEST}],
        "executorDigests": [{"path": "run.py", "digest": DIGEST}],
        "bundleDigest": DIGEST,
    }
    data.update(changes)
    return WorkloadPin.model_validate(data)


def _environment(**changes) -> EnvironmentPin:
    data = {
        "bakudoVersion": "3.0.0",
        "aboxVersion": "1.0.0",
        "imageDigest": DIGEST,
        "profile": "python-small",
        "hardwareClass": "test",
        "architecture": "arm64",
        "cpuCount": 2,
        "memoryMb": 512,
        "os": "linux",
        "kernel": "6.0",
        "runtimeVersions": [{"name": "python", "version": "3.12"}],
        "dependencyLockDigest": DIGEST,
        "environmentDigest": DIGEST,
    }
    data.update(changes)
    return EnvironmentPin.model_validate(data)


def test_workload_pin_round_trip_preserves_file_digests() -> None:
    pin = _workload()
    assert pin.ref == "loop@1.0.0"
    assert pin.dataset_digests == (FileDigest(path="data.json", digest=DIGEST),)
    assert WorkloadPin.model_validate(pin.model_dump(by_alias=True, mode="json")) == pin


def test_pin_compatibility_reports_every_mismatch_in_field_order() -> None:
    candidate = _workload(
        collectionRevision="r2",
        manifestDigest="sha256:" + "1" * 64,
        bundleDigest="sha256:" + "2" * 64,
    )
    mismatches = compare_workload_pins(_workload(), candidate)
    assert [item.split(":", 1)[0] for item in mismatches] == [
        "workload.collection_revision",
        "workload.manifest_digest",
        "workload.bundle_digest",
    ]


def test_environment_is_exact_by_default() -> None:
    report = compare_environment_pins(_environment(), _environment(bakudoVersion="3.0.1"))
    assert not report.compatible
    assert report.mismatches[0].startswith("environment.bakudo_version")


def test_explicit_policy_can_allow_patch_version_difference() -> None:
    report = compare_environment_pins(
        _environment(),
        _environment(bakudoVersion="3.0.1"),
        CompatibilityPolicy(allow_bakudo_patch_difference=True),
    )
    assert report.compatible
    assert report.mismatches == ()
    assert "allowed patch difference" in report.allowed_differences[0]


def test_revision_candidate_fields_must_be_paired() -> None:
    with pytest.raises(ValidationError, match="supplied together"):
        RevisionPin(
            repository="r",
            source_uri="file:///r",
            commit_sha="a" * 40,
            tree_digest=DIGEST,
            base_commit_sha="b" * 40,
        )
