from __future__ import annotations


def test_plan_live_coverage_slices_live_set_and_poller_exclusion() -> None:
    from hoga.live.coverage import plan_live_coverage

    codes = [f"{i:06d}" for i in range(7)]
    plan = plan_live_coverage(codes, n_configured=2, per_account_max=3)

    assert plan.live_set == tuple(codes[:6])
    assert plan.partitions == (
        tuple(codes[:3]),
        tuple(codes[3:6]),
    )
    assert plan.poller_excluded == frozenset(codes[:6])


def test_plan_live_coverage_keeps_empty_partitions_for_configured_accounts() -> None:
    from hoga.live.coverage import plan_live_coverage

    plan = plan_live_coverage(["005930"], n_configured=3, per_account_max=2)

    assert plan.live_set == ("005930",)
    assert plan.partitions == (("005930",), (), ())
    assert plan.poller_excluded == frozenset({"005930"})


def test_select_live_set_filters_unknown_codes_but_cold_cache_keeps_all() -> None:
    from hoga.live.coverage import select_live_set

    ordered = ["005930", "999999", "000660"]

    assert select_live_set(ordered, known_codes={"005930", "000660"}, max_codes=10) == (
        ("005930", "000660"),
        ("999999",),
    )
    assert select_live_set(ordered, known_codes=set(), max_codes=2) == (
        ("005930", "999999"),
        (),
    )
