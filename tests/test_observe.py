from bakudo.curriculum import (
    Advisory,
    CoverageGap,
    FailingTest,
    Issue,
    RepoSignals,
    Todo,
    generate_objectives,
)
from bakudo.curriculum.objective import ObjectiveType


def test_generates_objectives_from_each_signal_kind():
    signals = RepoSignals(
        repo="payments-api",
        issues=[Issue(1, "Add retry handling", labels=["priority:high", "bug"])],
        failing_tests=[FailingTest("test_webhook", "AssertionError")],
        todos=[Todo("src/x.py", "TODO: handle timeout")],
        coverage_gaps=[CoverageGap("src/y.py", covered_pct=0.2)],
        advisories=[Advisory("requests", "critical")],
    )
    objectives = generate_objectives(signals)
    types = {o.type for o in objectives}
    assert ObjectiveType.add_feature in types
    assert ObjectiveType.qa in types
    assert ObjectiveType.maintenance in types
    assert ObjectiveType.eval_author in types
    # All carry the repo and a computed priority order (descending score).
    assert all(o.repo == "payments-api" for o in objectives)
    scores = [o.priority.compute() for o in objectives]
    assert scores == sorted(scores, reverse=True)


def test_high_urgency_failing_test_outranks_todo():
    signals = RepoSignals(
        repo="r",
        failing_tests=[FailingTest("test_a")],
        todos=[Todo("z.py", "cleanup")],
    )
    objectives = generate_objectives(signals)
    assert objectives[0].type is ObjectiveType.qa


def test_dedupe_keeps_highest_value():
    signals = RepoSignals(
        repo="r",
        issues=[
            Issue(1, "Same title", labels=[]),
            Issue(2, "Same title", labels=["priority:high"]),
        ],
    )
    objectives = generate_objectives(signals)
    same = [o for o in objectives if o.title == "Same title"]
    assert len(same) == 1
    assert same[0].priority.value == 0.9  # the higher-labelled one won


def test_two_observe_cycles_over_unchanged_signals_yield_identical_ids():
    """MEM-6: the same TODO/issue/test must map to the SAME objective id every
    observer cycle, so dedupe-by-id in the meta workflow can hold."""

    def snapshot():
        return RepoSignals(
            repo="payments-api",
            issues=[Issue(7, "Add retry handling", labels=["bug"])],
            failing_tests=[FailingTest("test_webhook", "AssertionError")],
            todos=[Todo("src/x.py", "handle timeout")],
            coverage_gaps=[CoverageGap("src/y.py", covered_pct=0.2)],
            advisories=[Advisory("requests", "critical")],
        )

    first = {o.title: o.id for o in generate_objectives(snapshot())}
    second = {o.title: o.id for o in generate_objectives(snapshot())}
    assert first == second
    assert all(oid.startswith("objd_") for oid in first.values())


def test_observer_objective_ids_differ_across_repos():
    def snapshot(repo):
        return RepoSignals(repo=repo, todos=[Todo("src/x.py", "handle timeout")])

    (a,) = generate_objectives(snapshot("repo-a"))
    (b,) = generate_objectives(snapshot("repo-b"))
    assert a.id != b.id
