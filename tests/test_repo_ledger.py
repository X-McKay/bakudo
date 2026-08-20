"""Repo onboarding: ledger parity (InMemory + Postgres live-gated), the
``bakudo repo`` CLI, and registry-first resolution wiring (repo onboarding,
P2 Task 1).

API route coverage (POST/GET /repos) lives in ``tests/test_api.py``, and
``resolve_repo`` registry-first coverage lives in ``tests/test_abox_runner.py``,
per this task's file plan.
"""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

import pytest

from bakudo.registry import InMemoryLedger
from bakudo.registry.records import RepoRecord

# --------------------------------------------------------------------------
# ledger parity: InMemoryLedger always, PostgresLedger live-gated
# --------------------------------------------------------------------------

DSN = os.environ.get("BAKUDO_POSTGRES_DSN")


def _postgres_ledger():
    from bakudo.registry.postgres_ledger import _REPOS_DDL, PostgresLedger

    lg = PostgresLedger.connect(DSN)
    with lg._connection() as conn, conn.cursor() as cur:
        cur.execute(_REPOS_DDL)
        cur.execute("delete from repos where name like 'repo_ledger_test_%'")
    return lg


@pytest.fixture(params=["memory", pytest.param("postgres", marks=pytest.mark.live)])
def ledger(request):
    if request.param == "memory":
        yield InMemoryLedger()
        return
    if not DSN:
        pytest.skip("BAKUDO_POSTGRES_DSN not set")
    lg = _postgres_ledger()
    yield lg
    with lg._connection() as conn, conn.cursor() as cur:
        cur.execute("delete from repos where name like 'repo_ledger_test_%'")


def test_register_get_list_round_trip(ledger):
    record = RepoRecord(name="repo_ledger_test_a", source="/src/a", path="/checkouts/a")
    ledger.register_repo(record)

    got = ledger.get_repo("repo_ledger_test_a")
    assert got is not None
    assert got.source == "/src/a"
    assert got.path == "/checkouts/a"
    assert got.default_base_ref == "main"
    assert got.added_at is not None, "register_repo must stamp added_at when unset"

    names = {r.name for r in ledger.list_repos()}
    assert "repo_ledger_test_a" in names


def test_register_repo_idempotent_same_name_and_path(ledger):
    record = RepoRecord(name="repo_ledger_test_b", source="/src/b", path="/checkouts/b")
    ledger.register_repo(record)
    ledger.register_repo(record)  # must not raise
    matches = [r for r in ledger.list_repos() if r.name == "repo_ledger_test_b"]
    assert len(matches) == 1


def test_register_repo_conflicting_path_raises_value_error(ledger):
    ledger.register_repo(
        RepoRecord(name="repo_ledger_test_c", source="/src/c", path="/checkouts/c")
    )
    with pytest.raises(ValueError):
        ledger.register_repo(
            RepoRecord(name="repo_ledger_test_c", source="/src/c2", path="/checkouts/OTHER")
        )
    # the original registration must survive the rejected re-register
    assert ledger.get_repo("repo_ledger_test_c").path == "/checkouts/c"


def test_get_unknown_repo_returns_none(ledger):
    assert ledger.get_repo("repo_ledger_test_does_not_exist") is None


def test_deregister_repo_removes_entry(ledger):
    ledger.register_repo(
        RepoRecord(name="repo_ledger_test_d", source="/src/d", path="/checkouts/d")
    )
    ledger.deregister_repo("repo_ledger_test_d")
    assert ledger.get_repo("repo_ledger_test_d") is None


def test_deregister_unknown_name_raises_key_error(ledger):
    with pytest.raises(KeyError):
        ledger.deregister_repo("repo_ledger_test_does_not_exist")


# --------------------------------------------------------------------------
# add_repo() helper: rollback-on-register-failure (code review finding 1)
# --------------------------------------------------------------------------


def test_add_repo_rolls_back_clone_on_register_conflict(tmp_path):
    from bakudo.registry.repos import add_repo

    ledger = InMemoryLedger()
    # name "dup" already registered at a different path -- register_repo
    # will reject the clone's record with a ValueError.
    ledger.register_repo(RepoRecord(name="dup", source="/other", path=str(tmp_path / "A")))

    source = _init_git_repo(tmp_path / "source-repo")
    dest_root = tmp_path / "checkouts"
    dest_root.mkdir()

    with pytest.raises(ValueError):
        add_repo(f"file://{source}", name="dup", ledger=ledger, repo_root=dest_root)

    cloned = dest_root / "dup"
    assert not cloned.exists(), "a clone made by a rejected register must be rolled back"

    # Retrying with the SAME name must reach the real conflict again (a
    # plain ValueError), not RepoTargetExistsError from an orphaned clone
    # directory left behind by the first attempt.
    with pytest.raises(ValueError):
        add_repo(f"file://{source}", name="dup", ledger=ledger, repo_root=dest_root)
    assert not cloned.exists()

    # A fresh name still succeeds cleanly.
    record = add_repo(f"file://{source}", name="dup2", ledger=ledger, repo_root=dest_root)
    assert record.path == str((dest_root / "dup2").resolve())


def test_add_repo_local_path_conflict_never_touches_filesystem(tmp_path):
    """Rollback only removes a directory THIS call cloned -- a local path
    registered in place must never be deleted, conflict or not."""
    from bakudo.registry.repos import add_repo

    ledger = InMemoryLedger()
    other = tmp_path / "other"
    other.mkdir()
    ledger.register_repo(RepoRecord(name="dup", source="/other", path=str(other)))

    local = _init_git_repo(tmp_path / "local-repo")
    with pytest.raises(ValueError):
        add_repo(str(local), name="dup", ledger=ledger)

    assert local.exists() and (local / ".git").exists(), (
        "register-in-place must never be deleted on a register conflict"
    )


# --------------------------------------------------------------------------
# `bakudo repo` CLI
# --------------------------------------------------------------------------


def _init_git_repo(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    subprocess.run(["git", "init", "-q", "-b", "main", str(path)], check=True)
    subprocess.run(["git", "-C", str(path), "config", "user.email", "t@t"], check=True)
    subprocess.run(["git", "-C", str(path), "config", "user.name", "t"], check=True)
    subprocess.run(["git", "-C", str(path), "config", "commit.gpgsign", "false"], check=True)
    (path / "README.md").write_text("hi\n")
    subprocess.run(["git", "-C", str(path), "add", "-A"], check=True)
    subprocess.run(["git", "-C", str(path), "commit", "-q", "-m", "init"], check=True)
    return path


@pytest.fixture
def shared_ledger(monkeypatch):
    """`bakudo repo` gets a fresh InMemoryLedger per CLI invocation (Task 2
    wires a durable factory); tests that chain `add` -> `list`/`remove`
    across separate `main()` calls need one shared instance in between."""
    import bakudo.cli as cli

    lg = InMemoryLedger()
    monkeypatch.setattr(cli, "_repo_ledger", lambda: lg)
    return lg


def test_cli_repo_add_local_path_then_list(monkeypatch, tmp_path, capsys, shared_ledger):
    from bakudo.cli import main

    repo = _init_git_repo(tmp_path / "myrepo")

    rc = main(["repo", "add", str(repo), "--json"])
    assert rc == 0
    added = json.loads(capsys.readouterr().out)
    assert added["name"] == "myrepo"
    assert added["path"] == str(repo.resolve())
    assert added["source"] == str(repo)

    rc = main(["repo", "list", "--json"])
    assert rc == 0
    listed = json.loads(capsys.readouterr().out)
    assert [r["name"] for r in listed] == ["myrepo"]
    assert listed[0]["path"] == str(repo.resolve())


def test_cli_repo_add_url_via_file_clone(monkeypatch, tmp_path, capsys, shared_ledger):
    """No network required: git supports file:// clones."""
    from bakudo.cli import main

    source = _init_git_repo(tmp_path / "source-repo")
    dest_root = tmp_path / "checkouts"
    dest_root.mkdir()
    monkeypatch.setenv("BAKUDO_REPO_ROOT", str(dest_root))

    rc = main(["repo", "add", f"file://{source}", "--json"])
    assert rc == 0
    added = json.loads(capsys.readouterr().out)
    assert added["name"] == "source-repo"

    cloned = dest_root / "source-repo"
    assert cloned.is_dir()
    assert (cloned / ".git").is_dir()
    assert added["path"] == str(cloned.resolve())


def test_cli_repo_add_refuses_existing_clone_target(monkeypatch, tmp_path, capsys, shared_ledger):
    from bakudo.cli import main

    source = _init_git_repo(tmp_path / "source-repo")
    dest_root = tmp_path / "checkouts"
    (dest_root / "source-repo").mkdir(parents=True)
    monkeypatch.setenv("BAKUDO_REPO_ROOT", str(dest_root))

    rc = main(["repo", "add", f"file://{source}"])
    assert rc == 1
    assert "already exists" in capsys.readouterr().err


def test_cli_repo_add_missing_local_path_errors(capsys, shared_ledger, tmp_path):
    from bakudo.cli import main

    rc = main(["repo", "add", str(tmp_path / "nope")])
    assert rc == 1
    assert "does not exist" in capsys.readouterr().err


def test_cli_repo_add_non_git_local_path_errors(capsys, shared_ledger, tmp_path):
    from bakudo.cli import main

    plain_dir = tmp_path / "not-a-repo"
    plain_dir.mkdir()
    rc = main(["repo", "add", str(plain_dir)])
    assert rc == 1
    assert "not a git checkout" in capsys.readouterr().err


def test_cli_repo_remove_deregisters_without_deleting_files(capsys, shared_ledger, tmp_path):
    from bakudo.cli import main

    repo = _init_git_repo(tmp_path / "myrepo")
    main(["repo", "add", str(repo)])
    capsys.readouterr()

    rc = main(["repo", "remove", "myrepo"])
    assert rc == 0
    out = capsys.readouterr().out
    assert "files left in place" in out
    assert str(repo.resolve()) in out

    assert repo.exists() and (repo / ".git").exists(), "remove must never touch the filesystem"
    assert shared_ledger.get_repo("myrepo") is None


def test_cli_repo_remove_unknown_name_exits_1(capsys, shared_ledger):
    from bakudo.cli import main

    rc = main(["repo", "remove", "does-not-exist"])
    assert rc == 1


def test_cli_repo_add_rolls_back_clone_on_register_conflict(
    monkeypatch, tmp_path, capsys, shared_ledger
):
    """Code review finding 1: register a repo under name X at path A, then
    `repo add` a file:// URL with --name X -> error AND the clone target
    does not remain on disk (so a retry reaches the real conflict again,
    not a misleading 'target already exists')."""
    from bakudo.cli import main

    other = tmp_path / "other-checkout"
    other.mkdir()
    shared_ledger.register_repo(RepoRecord(name="dup", source="/other", path=str(other)))

    source = _init_git_repo(tmp_path / "source-repo")
    dest_root = tmp_path / "checkouts"
    dest_root.mkdir()
    monkeypatch.setenv("BAKUDO_REPO_ROOT", str(dest_root))

    rc = main(["repo", "add", f"file://{source}", "--name", "dup"])
    assert rc == 1
    err = capsys.readouterr().err
    assert "already registered" in err
    assert not (dest_root / "dup").exists(), "the orphaned clone must be rolled back"

    # Retry must reach the same real conflict, not "target already exists".
    rc = main(["repo", "add", f"file://{source}", "--name", "dup"])
    assert rc == 1
    err2 = capsys.readouterr().err
    assert "already registered" in err2
    assert "already exists" not in err2
