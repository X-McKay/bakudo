import re

import pytest

from bakudo import ids


def test_ulid_is_26_crockford_chars():
    u = ids.new_ulid()
    assert len(u) == 26
    assert re.fullmatch(r"[0-9A-HJKMNP-TV-Z]{26}", u)


def test_prefixed_ids():
    assert ids.run_id().startswith("run_")
    assert ids.objective_id().startswith("obj_")
    assert ids.new_measurement_id().startswith("measurement_")
    assert ids.new_snapshot_id().startswith("snapshot_")
    assert ids.new_comparison_id().startswith("comparison_")
    assert ids.new_regression_id().startswith("regression_")
    assert ids.git_branch_for("run_X") == "agent/run_X"


def test_ulids_are_time_sortable():
    earlier = ids.new_ulid(now_ms=1)
    later = ids.new_ulid(now_ms=2_000_000_000_000)
    assert earlier < later


def test_deterministic_objective_id_is_stable_and_prefixed():
    a = ids.deterministic_objective_id("repo|maintenance|todo:src/x.py:handle timeout")
    b = ids.deterministic_objective_id("repo|maintenance|todo:src/x.py:handle timeout")
    assert a == b
    # Same format family as the other ids: prefix + 26 Crockford chars, but a
    # clearly distinguishable prefix (deterministic, observer-derived).
    assert re.fullmatch(r"objd_[0-9A-HJKMNP-TV-Z]{26}", a)


def test_deterministic_objective_id_differs_by_seed():
    a = ids.deterministic_objective_id("repo-a|qa|test:test_webhook")
    b = ids.deterministic_objective_id("repo-b|qa|test:test_webhook")
    c = ids.deterministic_objective_id("repo-a|qa|test:test_billing")
    assert len({a, b, c}) == 3


def test_deterministic_id_is_stable_and_validates_prefix():
    value = ids.deterministic_id("regression", "measurement-a|latency")
    assert value == ids.deterministic_regression_id("measurement-a|latency")
    assert value.startswith("regression_")
    assert len(value.removeprefix("regression_")) == 26

    with pytest.raises(ValueError, match="prefix"):
        ids.deterministic_id("", "seed")
    with pytest.raises(ValueError, match="prefix"):
        ids.deterministic_id("not valid", "seed")
