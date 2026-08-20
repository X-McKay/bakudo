from bakudo.curriculum import Objective, ObjectiveQueues, Priority, QueueName
from bakudo.curriculum.objective import DEFAULT_WEIGHTS, rank


def test_priority_formula_matches_spec():
    # priority = .35v + .20u + .15l + .15c + .10d - .25r - .10cost
    p = Priority(
        value=1.0,
        urgency=1.0,
        learningValue=1.0,
        confidence=1.0,
        dependencyUnblockingValue=1.0,
        risk=1.0,
        estimatedCost=1.0,
    )
    expected = 0.35 + 0.20 + 0.15 + 0.15 + 0.10 - 0.25 - 0.10
    assert abs(p.compute() - expected) < 1e-9


def test_high_risk_lowers_score():
    safe = Priority(value=0.8, risk=0.0)
    risky = Priority(value=0.8, risk=1.0)
    assert safe.compute() > risky.compute()


def _obj(title, **prio):
    return Objective(type="add-feature", repo="r", title=title, priority=Priority(**prio))


def test_rank_orders_by_score_desc():
    objs = [_obj("low", value=0.1), _obj("high", value=0.9), _obj("mid", value=0.5)]
    ordered = rank(objs, DEFAULT_WEIGHTS)
    assert [o.title for o in ordered] == ["high", "mid", "low"]
    assert ordered[0].priority.score is not None


def test_queue_next_ready_picks_highest_priority():
    q = ObjectiveQueues()
    q.add(_obj("low", value=0.2))
    q.add(_obj("high", value=0.95))
    assert q.next_ready().title == "high"
    assert q.counts()[QueueName.ready.value] == 2
