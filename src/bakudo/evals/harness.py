"""Execute an eval corpus against a fixture repository (§22, §6.4).

Bridges the declarative corpus format (:mod:`bakudo.evals.corpus`) to real
sandboxed execution: each case gets a fresh copy of the fixture repo as its
workspace, runs through :func:`bakudo.abox.local.local_sandbox`, and comes
back as a :class:`CaseRun` for grading. The harness — not the agent — owns
the workspace copy, so a case can never contaminate its siblings.

Offline mode (``BAKUDO_OFFLINE=1``) runs the whole plumbing with the no-model
driver; scores are then honest about the driver ("blocked" everywhere), which
is exactly what `bakudo eval-corpus` reports.
"""

from __future__ import annotations

import shutil
import tempfile
from collections.abc import Callable
from pathlib import Path

from .. import ids
from ..abox.local import _git_init, local_sandbox
from ..agent_spec import AgentSpec
from ..bundle import Budget, TaskBundle
from ..curriculum.objective import Objective
from ..runner.agent import OfflineDriver
from ..runner.result import RunResult, RunStatus
from .checks import OPTIMIZE_SUITE
from .corpus import CaseRun, CorpusReport, load_corpus, run_corpus_report

# A case runner maps an objective to an observed CaseRun.
CaseRunner = Callable[[Objective], CaseRun]


def make_fixture_case_runner(
    spec: AgentSpec,
    fixture_root: str | Path,
    *,
    offline_driver: OfflineDriver | None = None,
    keep_workspaces: bool = False,
) -> CaseRunner:
    """Build a ``run_fn`` that executes each case in a fresh fixture copy."""
    fixture_root = Path(fixture_root)
    if not fixture_root.is_dir():
        raise FileNotFoundError(f"Fixture repository not found: {fixture_root}")

    def run_case(objective: Objective) -> CaseRun:
        workspace = Path(tempfile.mkdtemp(prefix="bakudo-case-"))
        try:
            workdir = workspace / "repo"
            shutil.copytree(
                fixture_root, workdir, ignore=shutil.ignore_patterns(".git", "__pycache__")
            )
            _git_init(workdir)

            bundle = TaskBundle(
                run_id=ids.run_id(),
                objective_id=objective.id,
                objective=objective,
                agent_spec=spec,
                budget=Budget(timeoutSeconds=spec.sandbox.timeout_seconds),
            )
            outcome = local_sandbox(
                bundle, offline_driver=offline_driver, workspace_root=workdir
            )
            if outcome.result:
                result = RunResult.model_validate(outcome.result)
            else:
                result = RunResult(
                    run_id=bundle.run_id,
                    agent=spec.ref,
                    objective_id=objective.id,
                    status=RunStatus.failed,
                    summary="no result produced",
                )
            return CaseRun(
                result=result,
                diff=outcome.diff,
                denied_commands=outcome.denied_commands,
                runtime_seconds=outcome.runtime_seconds,
                tokens_used=outcome.tokens_used,
            )
        finally:
            if not keep_workspaces:
                shutil.rmtree(workspace, ignore_errors=True)

    return run_case


def run_corpus_against_fixture(
    corpus_path: str | Path,
    spec: AgentSpec,
    fixture_root: str | Path,
    *,
    offline_driver: OfflineDriver | None = None,
    limit: int | None = None,
) -> CorpusReport:
    """Load a corpus and execute (up to ``limit``) cases against the fixture."""
    suite_name, cases = load_corpus(corpus_path)
    if limit is not None:
        cases = cases[:limit]
    run_fn = make_fixture_case_runner(spec, fixture_root, offline_driver=offline_driver)
    return run_corpus_report(
        suite_name,
        cases,
        run_fn,
        subject_id=spec.ref,
        graders=OPTIMIZE_SUITE,
    )
