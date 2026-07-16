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


def test_plan_storage_targets_ws_only_excludes_rest() -> None:
    from hoga.live.coverage import plan_storage_targets

    plan = plan_storage_targets(
        ["A", "B", "C"],
        n_configured=1,
        per_account_max=2,
        storage_policy="ws_only",
    )

    assert plan.ws_targets == ("A", "B")
    assert plan.kis_api_targets == ()
    assert plan.capture_candidates == ("A", "B", "C")


def test_plan_storage_targets_ws_plus_rest_uses_remainder() -> None:
    from hoga.live.coverage import plan_storage_targets

    plan = plan_storage_targets(
        ["A", "B", "C"],
        n_configured=1,
        per_account_max=2,
        storage_policy="ws_plus_rest",
        current_ws_live_set=("legacy",),
    )

    assert plan.ws_targets == ("A", "B")
    assert plan.kis_api_targets == ("C",)


def test_plan_storage_targets_rest_only_disables_ws() -> None:
    from hoga.live.coverage import plan_storage_targets

    plan = plan_storage_targets(
        ["A", "B", "C"],
        n_configured=3,
        per_account_max=2,
        storage_policy="rest_only",
    )

    assert plan.ws_targets == ()
    assert plan.kis_api_targets == ("A", "B", "C")


def test_plan_storage_targets_rest_extras_append_to_api_only() -> None:
    from hoga.live.coverage import plan_storage_targets

    plan = plan_storage_targets(
        ["A", "B", "C"],
        n_configured=1,
        per_account_max=2,
        storage_policy="ws_plus_rest",
        rest_extra_candidates=("H1", "B", "H2", "H1"),
    )

    # Extras (heatmap, ADR-0097) never enter WS slots; dedup against the
    # watchlist candidates ("B") and against themselves ("H1" twice).
    assert plan.ws_targets == ("A", "B")
    assert plan.kis_api_targets == ("C", "H1", "H2")
    assert plan.capture_candidates == ("A", "B", "C")


def test_plan_storage_targets_rest_extras_never_fill_free_ws_slots() -> None:
    from hoga.live.coverage import plan_storage_targets

    plan = plan_storage_targets(
        ["A"],
        n_configured=1,
        per_account_max=10,
        storage_policy="ws_plus_rest",
        rest_extra_candidates=("H1",),
    )

    # WS slots are free, but extras stay REST-only — heatmap edits must never
    # churn the WS subscription set (ADR-0097).
    assert plan.ws_targets == ("A",)
    assert plan.kis_api_targets == ("H1",)


def test_plan_storage_targets_rest_extras_dropped_under_ws_only() -> None:
    from hoga.live.coverage import plan_storage_targets

    plan = plan_storage_targets(
        ["A", "B"],
        n_configured=1,
        per_account_max=2,
        storage_policy="ws_only",
        rest_extra_candidates=("H1",),
    )

    assert plan.ws_targets == ("A", "B")
    assert plan.kis_api_targets == ()


def test_plan_storage_targets_rest_only_appends_extras_after_candidates() -> None:
    from hoga.live.coverage import plan_storage_targets

    plan = plan_storage_targets(
        ["A", "B"],
        n_configured=1,
        per_account_max=2,
        storage_policy="rest_only",
        rest_extra_candidates=("H1", "A"),
    )

    assert plan.ws_targets == ()
    assert plan.kis_api_targets == ("A", "B", "H1")


def test_plan_storage_targets_does_not_silently_cap_rest_targets() -> None:
    from hoga.live.coverage import plan_storage_targets

    candidates = [f"{i:06d}" for i in range(50)]
    plan = plan_storage_targets(
        candidates,
        n_configured=1,
        per_account_max=10,
        storage_policy="rest_only",
    )

    assert plan.kis_api_targets == tuple(candidates)


def test_plan_storage_targets_fallback_joins_rest_under_ws_plus_rest() -> None:
    """해결안 ③: 폴백 종목은 ws_targets 소속이어도 kis_api_targets에 병합된다
    (WS-XOR-REST 불변식의 의도적 예외 — 후보 dedup를 타지 않는 별도 파라미터).
    기존 REST 타깃과는 dedupe."""
    from hoga.live.coverage import plan_storage_targets

    plan = plan_storage_targets(
        ["005930", "000660", "035420"],
        n_configured=1,
        storage_policy="ws_plus_rest",
        per_account_max=2,          # ws=[005930,000660], rest 잔여=[035420]
        rest_fallback_codes=("000660", "035420"),   # 000660=WS 소속, 035420=이미 REST
    )
    assert plan.ws_targets == ("005930", "000660")
    # 잔여(035420) 뒤에 폴백(000660)만 append — 035420은 dedupe로 중복 없음.
    assert plan.kis_api_targets == ("035420", "000660")


def test_plan_storage_targets_fallback_dropped_under_ws_only() -> None:
    """ws_only는 REST 저장 금지 정책 — 폴백도 heatmap extras와 같은 선례로 드롭."""
    from hoga.live.coverage import plan_storage_targets

    plan = plan_storage_targets(
        ["005930"],
        n_configured=1,
        storage_policy="ws_only",
        rest_fallback_codes=("005930",),
    )
    assert plan.kis_api_targets == ()


def test_plan_storage_targets_fallback_noop_under_rest_only() -> None:
    """rest_only는 이미 전 종목 REST — 폴백은 dedupe가 흡수(중복 없음)."""
    from hoga.live.coverage import plan_storage_targets

    plan = plan_storage_targets(
        ["005930", "000660"],
        n_configured=1,
        storage_policy="rest_only",
        rest_fallback_codes=("000660",),
    )
    assert plan.kis_api_targets == ("005930", "000660")


# ── 키움 WS 라우팅 (ADR-0116, PR-3) ──


def test_plan_storage_targets_kiwoom_disabled_is_byte_identical() -> None:
    """kiwoom_enabled=False(기본): 히트맵은 기존대로 KIS REST, kiwoom_targets=().
    킬스위치 off일 때 plan 출력 불변 — 회귀 방지 골든."""
    from hoga.live.coverage import plan_storage_targets

    plan = plan_storage_targets(
        ["A", "B", "C"],
        n_configured=1,
        per_account_max=2,
        storage_policy="ws_plus_rest",
        rest_extra_candidates=("H1", "H2"),
    )
    assert plan.ws_targets == ("A", "B")
    assert plan.kis_api_targets == ("C", "H1", "H2")  # 히트맵 KIS REST (기존)
    assert plan.kiwoom_targets == ()


def test_plan_storage_targets_kiwoom_diverts_heatmap_from_kis_rest() -> None:
    """kiwoom_enabled=True: 히트맵(rest_extra)이 kiwoom_targets로 가고 KIS REST에서 빠짐.
    관심종목 잔여(C)는 그대로 KIS REST 유지 — 히트맵만 diverted."""
    from hoga.live.coverage import plan_storage_targets

    plan = plan_storage_targets(
        ["A", "B", "C"],
        n_configured=1,
        per_account_max=2,
        storage_policy="ws_plus_rest",
        rest_extra_candidates=("H1", "H2"),
        kiwoom_enabled=True,
    )
    assert plan.ws_targets == ("A", "B")       # KIS WS 관심종목 불변
    assert plan.kis_api_targets == ("C",)      # 관심 잔여만, 히트맵 빠짐
    assert plan.kiwoom_targets == ("H1", "H2")  # 히트맵 → 키움


def test_plan_storage_targets_kiwoom_captures_heatmap_under_ws_only() -> None:
    """ws_only는 KIS REST 저장 금지라 히트맵이 원래 드롭됐지만, kiwoom_enabled면
    키움 WS(별개 수집기)로 캡처된다 — off일 때만 드롭."""
    from hoga.live.coverage import plan_storage_targets

    plan = plan_storage_targets(
        ["A", "B"],
        n_configured=1,
        per_account_max=2,
        storage_policy="ws_only",
        rest_extra_candidates=("H1",),
        kiwoom_enabled=True,
    )
    assert plan.kis_api_targets == ()
    assert plan.kiwoom_targets == ("H1",)


def test_partition_kiwoom_slices_200_per_account() -> None:
    from hoga.live.coverage import KIWOOM_PER_ACCOUNT_MAX, partition_kiwoom

    assert KIWOOM_PER_ACCOUNT_MAX == 200
    codes = [f"{i:06d}" for i in range(450)]
    parts = partition_kiwoom(codes, 4)
    assert [len(p) for p in parts] == [200, 200, 50, 0]
    assert parts[0] == tuple(codes[:200]) or parts[0] == codes[:200]
    # 4앱키 = 800 상한, 450종목은 3계정에 담김(4번째 빈 리스트).
    assert sum(len(p) for p in parts) == 450
