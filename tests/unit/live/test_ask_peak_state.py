import random

from hoga.live.ask_peak_state import (
    _PENDING_MINUTE_SLACK,
    _TOUCH_WINDOW_MS,
    TodayAskPeakState,
    TodayBidPeakState,
)


#: 분 `m` 안의 오프셋 `ms` 시각. 분 경계가 이 파일의 유일한 판정 축이라 이름으로 드러낸다.
def at(m: int, ms: int = 0) -> int:
    return m * _TOUCH_WINDOW_MS + ms


def test_trade_tick_updates_touch_extreme_only_for_continuous_sides():
    state = TodayAskPeakState()

    state.ingest_trade(price=10_000, side=1, t_ms=at(10, 1))
    state.ingest_trade(price=10_050, side=-1, t_ms=at(10, 2))
    state.ingest_trade(price=10_900, side=0, t_ms=at(10, 3))     # 동시호가 크로스
    state.ingest_trade(price=10_950, side=2, t_ms=at(10, 4))     # 예상체결

    # 매도 쪽 극값은 max — side 0/2 가 섞였다면 10_950 이 됐을 것이다.
    assert state.touch_extreme_by_minute == {10: 10_050}


def test_ask_wall_touched_by_same_minute_tick_moves_to_traded():
    state = TodayAskPeakState()
    state.ingest_orderbook(t_ms=at(10, 1_000), asks=[{"price": 10_100, "qty": 500}])

    before = state.snapshot()
    assert before == {
        "coverage": "partial",
        "traded_price": None,
        "traded_qty": None,
        "traded_t_ms": None,
        "traded_peaks": [],
        "all_price": 10_100,
        "all_qty": 500,
        "all_t_ms": at(10, 1_000),
        "all_peaks": [{"price": 10_100, "qty": 500, "t_ms": at(10, 1_000)}],
    }

    state.ingest_trade(price=10_100, side=1, t_ms=at(10, 2_000))

    assert state.snapshot() == {
        "coverage": "partial",
        "traded_price": 10_100,
        "traded_qty": 500,
        "traded_t_ms": at(10, 1_000),
        "traded_peaks": [{"price": 10_100, "qty": 500, "t_ms": at(10, 1_000)}],
        "all_price": 10_100,
        "all_qty": 500,
        "all_t_ms": at(10, 1_000),
        "all_peaks": [{"price": 10_100, "qty": 500, "t_ms": at(10, 1_000)}],
    }


def test_trade_in_a_different_minute_does_not_touch_the_wall():
    """ADR-0156 의 핵심 — 가격이 같아도 **분이 다르면** 체결이 아니다.

    막는 방향: 터치 창이 분보다 넓어지는 쪽(ADR-0084 의 "이후 아무 때나").
    못 보는 것: 지연 도착 관용치(`_PENDING_MINUTE_SLACK`) 밖으로 밀린 벽 —
    아래 pruning 테스트가 본다.
    """
    state = TodayAskPeakState()
    state.ingest_orderbook(t_ms=at(10, 1_000), asks=[{"price": 10_100, "qty": 500}])
    state.ingest_trade(price=10_100, side=1, t_ms=at(11, 1_000))

    snap = state.snapshot()
    assert snap is not None
    assert snap["traded_peaks"] == []
    # 터치와 무관한 `all_*` 에는 그대로 남는다.
    assert snap["all_peaks"] == [{"price": 10_100, "qty": 500, "t_ms": at(10, 1_000)}]


def test_trade_preceding_the_wall_in_the_same_minute_still_touches():
    """체결이 벽보다 **앞서도** 같은 분이면 터치다.

    기본 기준(rep)의 벽은 그 분의 마지막 호가창에서 관측되므로, "체결이 벽 이후" 만
    세면 그 경로가 거의 전부 미터치가 된다 — ADR-0156 이 순서를 판정에서 뺀 이유.
    """
    state = TodayAskPeakState()
    state.ingest_trade(price=10_100, side=1, t_ms=at(10, 1_000))
    state.ingest_orderbook(t_ms=at(10, 50_000), asks=[{"price": 10_100, "qty": 500}])

    snap = state.snapshot()
    assert snap is not None
    assert snap["traded_peaks"] == [{"price": 10_100, "qty": 500, "t_ms": at(10, 50_000)}]


def test_bid_uses_lower_or_equal_domination():
    state = TodayBidPeakState()
    state.ingest_orderbook(t_ms=at(10, 1_000), bids=[{"price": 70_000, "qty": 5_000}])
    state.ingest_trade(price=70_100, side=1, t_ms=at(10, 2_000))   # 고가 → 매수벽 미지배

    snap = state.snapshot()
    assert snap is not None
    assert snap["traded_peaks"] == []

    state.ingest_trade(price=70_000, side=1, t_ms=at(10, 3_000))
    snap = state.snapshot()
    assert snap is not None
    assert snap["traded_peaks"] == [{"price": 70_000, "qty": 5_000, "t_ms": at(10, 1_000)}]


def test_same_price_wall_in_a_later_minute_is_judged_on_its_own_minute():
    state = TodayAskPeakState()
    state.ingest_orderbook(t_ms=at(10, 1_000), asks=[{"price": 10_100, "qty": 500}])
    state.ingest_trade(price=10_100, side=1, t_ms=at(10, 2_000))
    state.ingest_orderbook(t_ms=at(11, 1_000), asks=[{"price": 10_100, "qty": 900}])

    snap = state.snapshot()
    assert snap is not None
    # 더 큰 900 벽은 자기 분(11)에 체결이 없어 체결 계열에 못 들어간다.
    assert snap["traded_peaks"] == [{"price": 10_100, "qty": 500, "t_ms": at(10, 1_000)}]
    # `all_*` 은 가격당 최대 — 900 이 이긴다.
    assert snap["all_peaks"] == [{"price": 10_100, "qty": 900, "t_ms": at(11, 1_000)}]


def test_many_same_price_updates_within_a_minute_emit_one_traded_candidate():
    state = TodayAskPeakState()
    for i, qty in enumerate(range(1000, 1100), start=1):
        state.ingest_orderbook(t_ms=at(10, i), asks=[{"price": 10_000, "qty": qty}])
    state.ingest_trade(price=10_000, side=1, t_ms=at(10, 50_000))

    snap = state.snapshot()
    assert snap is not None
    assert len(state.closed_traded) == 1
    assert snap["traded_peaks"] == [{"price": 10_000, "qty": 1099, "t_ms": at(10, 100)}]


def test_pending_walls_are_pruned_once_their_minute_can_no_longer_be_touched():
    """자기 분이 지난 미터치 벽은 버린다 — 메모리 상한의 근거.

    막는 방향: 대기열이 하루 내내 자라는 것(300종목 × 2 side 가 한 프로세스에 있다).
    `all_top` 은 별도 구조라 무손실이다 — 청소된 분의 벽도 `all_*` 에는 남는다.
    """
    state = TodayAskPeakState()
    for m in range(10, 10 + _PENDING_MINUTE_SLACK + 4):
        state.ingest_orderbook(t_ms=at(m, 1_000), asks=[{"price": 10_000 + m, "qty": 100 + m}])

    assert len(state.pending_by_minute) <= _PENDING_MINUTE_SLACK + 1
    # 청소된 분의 벽도 all 계열에는 남는다.
    assert len(state.all_top) <= 3
    snap = state.snapshot()
    assert snap is not None
    assert snap["all_price"] == 10_000 + (10 + _PENDING_MINUTE_SLACK + 3)


def test_side_zero_trade_is_ignored_for_touch_classification():
    state = TodayAskPeakState()
    state.ingest_orderbook(t_ms=at(10, 1_000), asks=[{"price": 10_100, "qty": 500}])
    state.ingest_trade(price=10_100, side=0, t_ms=at(10, 2_000))

    assert state.touch_extreme_by_minute == {}
    snap = state.snapshot()
    assert snap is not None
    assert snap["traded_peaks"] == []


def test_snapshot_ranks_and_caps_families_to_top_three():
    state = TodayAskPeakState()
    state.ingest_orderbook(
        t_ms=at(10, 1_000),
        asks=[
            {"price": 10_000, "qty": 400},
            {"price": 10_050, "qty": 800},
            {"price": 10_100, "qty": 700},
            {"price": 10_150, "qty": 600},
            {"price": 10_200, "qty": 500},
            {"price": 10_250, "qty": 300},
        ],
    )
    state.ingest_trade(price=10_100, side=1, t_ms=at(10, 2_000))
    snap = state.snapshot()

    assert snap is not None
    assert snap["traded_peaks"] == [
        {"price": 10_050, "qty": 800, "t_ms": at(10, 1_000)},
        {"price": 10_100, "qty": 700, "t_ms": at(10, 1_000)},
        {"price": 10_000, "qty": 400, "t_ms": at(10, 1_000)},
    ]
    assert snap["all_peaks"] == [
        {"price": 10_050, "qty": 800, "t_ms": at(10, 1_000)},
        {"price": 10_100, "qty": 700, "t_ms": at(10, 1_000)},
        {"price": 10_150, "qty": 600, "t_ms": at(10, 1_000)},
    ]


def test_closed_state_stays_bounded_after_many_touches():
    state = TodayAskPeakState()

    for idx in range(10):
        price = 10_000 + (idx * 10)
        state.ingest_orderbook(t_ms=at(10 + idx, 1_000), asks=[{"price": price, "qty": 100 + idx}])
        state.ingest_trade(price=price, side=1, t_ms=at(10 + idx, 2_000))

    snap = state.snapshot()
    assert snap is not None
    assert len(state.closed_traded) == 3
    assert len(state.observed_peak_events) == 3
    assert len(state.all_best_by_price_time) == 3
    assert snap["traded_peaks"] == [
        {"price": 10_090, "qty": 109, "t_ms": at(19, 1_000)},
        {"price": 10_080, "qty": 108, "t_ms": at(18, 1_000)},
        {"price": 10_070, "qty": 107, "t_ms": at(17, 1_000)},
    ]
    assert snap["all_peaks"] == snap["traded_peaks"]


def test_all_top_matches_a_full_sort_over_every_wall_seen() -> None:
    """증분 top-3(`_offer_all`) == "가격당 최댓값 전량 정렬" 의 상위 3.

    막는 방향: 증분 유지가 전량 정렬과 갈리는 회귀. 이 등식이 성립해야 딕셔너리를
    안 들어도 되고, 그 딕셔너리가 없어야 틱 경로가 가격 수에 비례해 느려지지 않는다
    (회귀 실측: 가격 ~1,180 종목에서 하루 재생 3,508ms → 269ms).

    못 보는 것: 성능(그게 이유지만 여기서 재지 않는다 — 벽시계 단언은 이 리포에서
    기각됐다). 같은 가격이 top-3 를 독식하지 않는 성질은 위 랭킹 테스트가 본다.
    """
    from hoga.live.ask_peak_state import _EMIT_LIMIT, Peak, _ranked_peaks

    def oracle(walls: list[Peak]) -> list[tuple[int, int, int]]:
        best: dict[int, Peak] = {}
        for p in walls:
            cur = best.get(p.price)
            if cur is None or p.qty > cur.qty:
                best[p.price] = p
        return [(p.price, p.qty, p.t_ms) for p in _ranked_peaks(best.values())[:_EMIT_LIMIT]]

    rng = random.Random(20260821)
    for seed in range(120):
        rng.seed(seed)
        state = TodayAskPeakState()
        seen: list[Peak] = []
        for step in range(rng.randrange(1, 40)):
            t_ms = at(10 + step, rng.randrange(0, 60_000))
            levels = [
                {"price": 70_000 + 50 * rng.randrange(0, 12), "qty": 1 + rng.randrange(5_000)}
                for _ in range(rng.randrange(1, 6))
            ]
            state.ingest_orderbook(t_ms=t_ms, asks=levels)
            seen += [Peak(price=lv["price"], qty=lv["qty"], t_ms=t_ms, seq=None) for lv in levels]
            if rng.random() < 0.4:
                state.ingest_trade(price=70_000 + 50 * rng.randrange(0, 12), side=1, t_ms=t_ms + 1)
        assert [(p.price, p.qty, p.t_ms) for p in state.all_top] == oracle(seen), f"seed={seed}"


def test_rank_one_matches_full_sort_first_element() -> None:
    """`_rank_one` 은 `_ranked_peaks(...)[0]` 과 **항상 같아야 한다**.

    막는 방향: 1위 산출을 정렬에서 `min` 으로 바꾼 것이 동점 처리에서 갈리는 회귀.
    키가 `(-qty, t_ms, price, seq)` 전순서라 최솟값이 유일하므로 동일해야 한다 —
    동점(같은 qty·t_ms)을 일부러 섞어 그 전제를 실제로 밟는다.

    못 보는 것: 성능(그게 바꾼 이유지만 여기서 재지 않는다). 빈 입력은 아래에서 별도 단언.
    """
    from hoga.live.ask_peak_state import Peak, _rank_one, _ranked_peaks

    rng = random.Random(20260821)
    for n in (1, 2, 3, 17, 120):
        for _ in range(40):
            peaks = [
                Peak(
                    price=rng.randrange(1000, 1010),   # 좁은 범위 → 동점 유도
                    qty=rng.randrange(1, 5),
                    t_ms=rng.randrange(10**12, 10**12 + 5),
                    seq=rng.choice([None, 1, 2]),
                )
                for _ in range(n)
            ]
            assert _rank_one(peaks) == _ranked_peaks(peaks)[0]

    assert _rank_one([]) is None
