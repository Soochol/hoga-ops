from __future__ import annotations


# ── plan_storage_targets: 저장셋=키움 WS 전담(ADR-0118 PR-G 컷오버) ──
# KIS WebSocket 계층이 삭제돼 ws_targets는 항상 (). kiwoom off/무자격이면 저장셋도 빈다
# (fix-forward — REST/WS 폴백 없음, 커버리지는 계좌 추가로).


def test_plan_storage_targets_ws_targets_always_empty() -> None:
    from hoga.live.coverage import plan_storage_targets

    plan = plan_storage_targets(
        ["A", "B", "C"],
        n_configured=1,
        per_account_max=2,
    )

    # KIS WS 삭제 → ws_targets 항상 빈 튜플. kiwoom off면 저장셋도 빈다.
    assert plan.ws_targets == ()
    assert plan.capture_candidates == ("A", "B", "C")
    assert plan.kiwoom_targets == ()


def test_plan_storage_targets_no_capacity_drops_everything() -> None:
    """자격증명 부재(capacity 0, 앱키 없음): 히트맵도 관심종목도 어디에도 안 담긴다
    — 폴백 없음. ADR-0118: 활성화 스위치는 폐지, capacity>0(키 존재)만이 게이트."""
    from hoga.live.coverage import plan_storage_targets

    plan = plan_storage_targets(
        ["A", "B"],
        n_configured=1,
        per_account_max=2,
        heatmap_candidates=("H1", "H2"),
        # kiwoom_capacity 미지정 → 0(앱키 없음) → 미수집.
    )
    assert plan.ws_targets == ()
    assert plan.kiwoom_targets == ()


def test_plan_storage_targets_kiwoom_cutover_watchlist_and_heatmap_to_kiwoom() -> None:
    """관심종목 칼 컷오버(ADR-0118 PR-E): kiwoom 활성 시 관심종목+히트맵 dedup union이
    kiwoom_targets(저장셋)로, KIS ws_targets는 빈 튜플(→ KIS conn 자연 소멸). per_account_max
    (KIS 슬롯)는 관심종목에 더는 적용 안 됨 — 전량 kiwoom 용량까지."""
    from hoga.live.coverage import plan_storage_targets

    plan = plan_storage_targets(
        ["A", "B", "C"],
        n_configured=1,
        per_account_max=2,
        heatmap_candidates=("H1", "H2"),
        kiwoom_capacity=200,
    )
    assert plan.ws_targets == ()                                    # 관심종목 키움 이관
    assert plan.kiwoom_targets == ("A", "B", "C", "H1", "H2")       # 관심 먼저 + 히트맵
    assert plan.capture_candidates == ("A", "B", "C")


def test_plan_storage_targets_cutover_dedups_watchlist_and_self() -> None:
    """union dedup: 히트맵의 관심종목 중복(B)·자기중복(H1×2)은 1회만."""
    from hoga.live.coverage import plan_storage_targets

    plan = plan_storage_targets(
        ["A", "B", "C"],
        n_configured=1,
        per_account_max=2,
        heatmap_candidates=("H1", "B", "H2", "H1"),
        kiwoom_capacity=200,
    )
    assert plan.ws_targets == ()
    assert plan.kiwoom_targets == ("A", "B", "C", "H1", "H2")       # B·H1 중복 제거
    assert plan.capture_candidates == ("A", "B", "C")


def test_plan_storage_targets_cutover_whole_watchlist_regardless_of_ws_slots() -> None:
    """컷오버 후 관심종목은 KIS 슬롯(per_account_max) 무관하게 전량 kiwoom으로 — 예전
    슬롯에서 잘리던 종목(C)도 kiwoom 용량이 크므로 저장셋에 편입."""
    from hoga.live.coverage import plan_storage_targets

    plan = plan_storage_targets(
        ["A", "B", "C"],
        n_configured=1,
        per_account_max=1,          # 예전이면 ws=(A,), B·C 슬롯 밖 — 이젠 무관
        heatmap_candidates=("C", "H1"),
        kiwoom_capacity=200,
    )
    assert plan.ws_targets == ()
    assert plan.kiwoom_targets == ("A", "B", "C", "H1")   # 관심 전량 + H1(C는 관심과 중복)


def test_plan_storage_targets_cutover_capacity_prioritizes_watchlist() -> None:
    """kiwoom 용량 초과 시 관심종목 우선 채움, 초과 히트맵 드롭(계좌 추가로 대응)."""
    from hoga.live.coverage import plan_storage_targets

    plan = plan_storage_targets(
        ["A", "B"],
        n_configured=1,
        per_account_max=2,
        heatmap_candidates=("H1", "H2", "H3"),
        kiwoom_capacity=2,
    )
    assert plan.ws_targets == ()
    assert plan.kiwoom_targets == ("A", "B")   # 관심종목이 용량 채움 → 히트맵 전량 드롭


def test_plan_storage_targets_kiwoom_zero_capacity_collects_nothing() -> None:
    """앱키 0(capacity=0)이면 히트맵은 미수집 — 폴백 없음(ADR-0118: capacity가 곧 게이트)."""
    from hoga.live.coverage import plan_storage_targets

    plan = plan_storage_targets(
        ["A", "B"],
        n_configured=1,
        per_account_max=2,
        heatmap_candidates=("H1", "H2"),
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
