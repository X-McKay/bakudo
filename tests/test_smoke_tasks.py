from bakudo.paths import smoke_tasks_dir
from bakudo.tasks.source import DirectoryTaskSource, check_immutability


def test_exactly_two_smoke_tasks_load():
    reg = DirectoryTaskSource(smoke_tasks_dir())
    assert {task.ref for task in reg.list()} == {
        "smoke-rate-limiter-fix@1",
        "smoke-rate-limiter-nochange@1",
    }


def test_smoke_tasks_cover_change_and_no_change():
    reg = DirectoryTaskSource(smoke_tasks_dir())
    assert {task.spec.metadata.family.value for task in reg.list()} == {
        "debugging",
        "no-change",
    }


def test_no_change_smoke_task_has_existing_pair():
    reg = DirectoryTaskSource(smoke_tasks_dir())
    nochange = [s for s in reg.list() if s.spec.metadata.family.value == "no-change"]
    assert len(nochange) == 1
    for s in nochange:
        paired = s.spec.metadata.paired_task
        assert paired, f"{s.ref} has no pairedTask"
        reg.get(paired)


def test_digest_lock_clean():
    reg = DirectoryTaskSource(smoke_tasks_dir())
    assert check_immutability(reg, smoke_tasks_dir() / "digests.lock") == []


def test_canary_in_every_fixture_file():
    reg = DirectoryTaskSource(smoke_tasks_dir())
    for s in reg.list():
        for f in (s.path / "fixture").rglob("*"):
            if f.is_file():
                assert "bakudo-corpus-7f3d9a1c" in f.read_text(), f"missing canary: {f}"
