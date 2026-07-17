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


# ── plan_storage_targets: 관심종목=KIS WS 슬롯, 히트맵=키움 WS 용량 ──
# KIS REST 30s 캡처(rest30)·storage_policy는 제거됨(2026-07-17 정책: 호가는 api로
# 받지 않는다 — 폴백 없음, 커버리지는 계좌 추가로).


def test_plan_storage_targets_ws_slots_capped_by_accounts() -> None:
    from hoga.live.coverage import plan_storage_targets

    plan = plan_storage_targets(
        ["A", "B", "C"],
        n_configured=1,
        per_account_max=2,
    )

    # 슬롯(2×1) 초과분 C는 어디에도 안 담긴다 — REST 스필오버 없음.
    assert plan.ws_targets == ("A", "B")
    assert plan.capture_candidates == ("A", "B", "C")
    assert plan.kiwoom_targets == ()


def test_plan_storage_targets_ws_slots_scale_with_n_configured() -> None:
    from hoga.live.coverage import plan_storage_targets

    plan = plan_storage_targets(
        ["A", "B", "C"],
        n_configured=2,
        per_account_max=2,
    )

    assert plan.ws_targets == ("A", "B", "C")


def test_plan_storage_targets_kiwoom_disabled_drops_heatmap() -> None:
    """kiwoom off(기본): 히트맵은 어디에도 안 담긴다 — KIS REST 폴백 없음."""
    from hoga.live.coverage import plan_storage_targets

    plan = plan_storage_targets(
        ["A", "B"],
        n_configured=1,
        per_account_max=2,
        heatmap_candidates=("H1", "H2"),
    )
    assert plan.ws_targets == ("A", "B")
    assert plan.kiwoom_targets == ()


def test_plan_storage_targets_kiwoom_routes_heatmap() -> None:
    """kiwoom_enabled + capacity: 히트맵이 kiwoom_targets로 간다. WS 타깃 불변."""
    from hoga.live.coverage import plan_storage_targets

    plan = plan_storage_targets(
        ["A", "B", "C"],
        n_configured=1,
        per_account_max=2,
        heatmap_candidates=("H1", "H2"),
        kiwoom_enabled=True,
        kiwoom_capacity=200,
    )
    assert plan.ws_targets == ("A", "B")
    assert plan.kiwoom_targets == ("H1", "H2")


def test_plan_storage_targets_heatmap_dedups_against_watchlist_and_self() -> None:
    """관심종목 중복(B)은 KIS WS 전담이라 키움에서 dedup, 자기중복(H1×2)도 1회만."""
    from hoga.live.coverage import plan_storage_targets

    plan = plan_storage_targets(
        ["A", "B", "C"],
        n_configured=1,
        per_account_max=2,
        heatmap_candidates=("H1", "B", "H2", "H1"),
        kiwoom_enabled=True,
        kiwoom_capacity=200,
    )
    assert plan.ws_targets == ("A", "B")
    assert plan.kiwoom_targets == ("H1", "H2")
    assert plan.capture_candidates == ("A", "B", "C")


def test_plan_storage_targets_heatmap_dedups_even_beyond_ws_slots() -> None:
    """dedup 기준은 capture_candidates 전체(슬롯 밖 포함) — 슬롯에서 잘린 관심종목도
    KIS 소유라 키움에 넣지 않는다."""
    from hoga.live.coverage import plan_storage_targets

    plan = plan_storage_targets(
        ["A", "B", "C"],
        n_configured=1,
        per_account_max=1,          # ws=(A,), B·C는 슬롯 밖
        heatmap_candidates=("C", "H1"),
        kiwoom_enabled=True,
        kiwoom_capacity=200,
    )
    assert plan.ws_targets == ("A",)
    assert plan.kiwoom_targets == ("H1",)   # C는 관심종목 소속이라 제외


def test_plan_storage_targets_kiwoom_capacity_drops_overflow() -> None:
    """키움 용량 초과 히트맵은 드롭(미수집) — KIS 스필오버 없음(계좌 추가로 대응)."""
    from hoga.live.coverage import plan_storage_targets

    plan = plan_storage_targets(
        ["A", "B"],
        n_configured=1,
        per_account_max=2,
        heatmap_candidates=("H1", "H2", "H3"),
        kiwoom_enabled=True,
        kiwoom_capacity=2,
    )
    assert plan.kiwoom_targets == ("H1", "H2")


def test_plan_storage_targets_kiwoom_zero_capacity_collects_nothing() -> None:
    """kiwoom_enabled=True인데 앱키 0(capacity=0)이면 히트맵은 미수집 — 폴백 없음."""
    from hoga.live.coverage import plan_storage_targets

    plan = plan_storage_targets(
        ["A", "B"],
        n_configured=1,
        per_account_max=2,
        heatmap_candidates=("H1", "H2"),
        kiwoom_enabled=True,
        kiwoom_capacity=0,
    )
    assert plan.kiwoom_targets == ()


def test_partition_kiwoom_slices_200_per_account() -> None:
    from hoga.live.coverage import KIWOOM_PER_ACCOUNT_MAX, partition_kiwoom

    assert KIWOOM_PER_ACCOUNT_MAX == 200
    codes = [f"{i:06d}" for i in range(450)]
    parts = partition_kiwoom(codes, 4)
    assert [len(p) for p in parts] == [200, 200, 50, 0]
    assert list(parts[0]) == codes[:200]
    # 4앱키 = 800 상한, 450종목은 3계정에 담김(4번째 빈 리스트).
    assert sum(len(p) for p in parts) == 450
