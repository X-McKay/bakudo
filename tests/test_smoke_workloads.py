from bakudo.paths import smoke_workloads_dir
from bakudo.performance.source import DirectoryWorkloadSource


def test_packaged_smoke_workload_loads_and_pins_runner():
    source = DirectoryWorkloadSource(smoke_workloads_dir())
    assert [summary.ref for summary in source.list()] == ["smoke-python-loop@1.0.0"]
    loaded = source.load("smoke-python-loop")
    assert loaded.pin.executor_digests[0].path == "run.py"
    assert loaded.spec.command.argv[:2] == ("python", "run.py")
    assert {profiler.name for profiler in loaded.spec.profilers} == {
        "python-cpu",
        "synthetic",
    }
