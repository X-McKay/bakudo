import re

from bakudo import ids


def test_ulid_is_26_crockford_chars():
    u = ids.new_ulid()
    assert len(u) == 26
    assert re.fullmatch(r"[0-9A-HJKMNP-TV-Z]{26}", u)


def test_prefixed_ids():
    assert ids.run_id().startswith("run_")
    assert ids.objective_id().startswith("obj_")
    assert ids.git_branch_for("run_X") == "agent/run_X"


def test_ulids_are_time_sortable():
    earlier = ids.new_ulid(now_ms=1)
    later = ids.new_ulid(now_ms=2_000_000_000_000)
    assert earlier < later
