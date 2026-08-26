import random

from hoga.live.ask_peak_state import (
    _PENDING_MINUTE_SLACK,
    _TOUCH_WINDOW_MS,
    _TRADED_RECORD_CAP,
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
        "traded_record_peaks": [],
        "all_price": 10_100,
        "all_qty": 500,
        "all_t_ms": at(10, 1_000),
        "all_peaks": [{"price": 10_100, "qty": 500, "t_ms": at(10, 1_000)}],
        # 체결 0건 — 극값이 없으니 모든 벽이 미도달이다.
        "unreached_price": 10_100,
        "unreached_qty": 500,
        "unreached_t_ms": at(10, 1_000),
        "unreached_peaks": [{"price": 10_100, "qty": 500, "t_ms": at(10, 1_000)}],
        "day_extreme": None,
    }

    state.ingest_trade(price=10_100, side=1, t_ms=at(10, 2_000))

    assert state.snapshot() == {
        "coverage": "partial",
        "traded_price": 10_100,
        "traded_qty": 500,
        "traded_t_ms": at(10, 1_000),
        "traded_peaks": [{"price": 10_100, "qty": 500, "t_ms": at(10, 1_000)}],
        "traded_record_peaks": [{"price": 10_100, "qty": 500, "t_ms": at(10, 1_000)}],
        "all_price": 10_100,
        "all_qty": 500,
        "all_t_ms": at(10, 1_000),
        "all_peaks": [{"price": 10_100, "qty": 500, "t_ms": at(10, 1_000)}],
        # 체결 극값(10_100)이 벽 가격에 도달 — 미도달에서 소급 제거된다.
        "unreached_price": None,
        "unreached_qty": None,
        "unreached_t_ms": None,
        "unreached_peaks": [],
        "day_extreme": 10_100,
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


# ── 미도달(unreached) 계열 ────────────────────────────────────────────────────


def test_unreached_eviction_revives_lower_ranked_wall():
    """극값 전진이 1위를 소급 제거하면 **하위 벽이 되살아나야 한다** — top-3 offer
    (`_offer_all`)로는 원리적으로 안 되는 성질이라 가격별 딕셔너리가 존재하는 이유다."""
    state = TodayAskPeakState()
    state.ingest_orderbook(t_ms=at(10), asks=[
        {"price": 10_100, "qty": 900},   # 미도달 1위
        {"price": 10_300, "qty": 300},   # 미도달 2위
    ])

    snap = state.snapshot()
    assert (snap["unreached_price"], snap["unreached_qty"]) == (10_100, 900)

    # 체결이 10_200 까지 도달 — 10_100 벽은 소급 제거, 10_300 이 1위로 부활.
    state.ingest_trade(price=10_200, side=1, t_ms=at(11))
    snap = state.snapshot()
    assert (snap["unreached_price"], snap["unreached_qty"]) == (10_300, 300)
    assert snap["day_extreme"] == 10_200
    assert snap["unreached_peaks"] == [{"price": 10_300, "qty": 300, "t_ms": at(10)}]


def test_unreached_skips_prices_already_dominated_at_insert():
    """삽입 시점에 이미 극값 이하인 가격은 처음부터 담지 않는다 — 극값이 단조라
    하루 스코프 정의(최종 극값 기준)와 일치한다."""
    state = TodayAskPeakState()
    state.ingest_trade(price=10_200, side=1, t_ms=at(10))
    state.ingest_orderbook(t_ms=at(10, 1_000), asks=[
        {"price": 10_150, "qty": 900},   # 이미 도달된 가격 — 미도달 아님
        {"price": 10_250, "qty": 100},
    ])

    snap = state.snapshot()
    assert (snap["unreached_price"], snap["unreached_qty"]) == (10_250, 100)


def test_unreached_bid_symmetry_uses_day_low():
    state = TodayBidPeakState()
    state.ingest_orderbook(t_ms=at(10), bids=[
        {"price": 9_900, "qty": 700},
        {"price": 9_700, "qty": 200},
    ])
    state.ingest_trade(price=9_800, side=-1, t_ms=at(11))

    snap = state.snapshot()
    # 저가 9_800 이 9_900 을 지배(<=) — 9_700 만 미도달로 남는다.
    assert (snap["unreached_price"], snap["unreached_qty"]) == (9_700, 200)
    assert snap["day_extreme"] == 9_800


def test_merge_from_absorbs_unreached_and_extreme_idempotently():
    """재생본 흡수: 극값은 더 지배적인 쪽, 딕셔너리는 larger 병합 후 걷어냄 — 같은
    재생본을 두 번 흡수해도 고정점이다(merge_from 의 멱등 규약)."""
    live = TodayAskPeakState()
    live.ingest_orderbook(t_ms=at(20), asks=[{"price": 10_400, "qty": 50}])

    replay = TodayAskPeakState()
    replay.ingest_orderbook(t_ms=at(5), asks=[
        {"price": 10_300, "qty": 800},
        {"price": 10_400, "qty": 400},
    ])
    replay.ingest_trade(price=10_350, side=1, t_ms=at(6))  # 10_300 은 재생 안에서 도달

    live.merge_from(replay)
    first = live.snapshot()
    # 재생 극값(10_350)이 흡수돼 10_300 은 없고, 10_400 은 larger(400) 로 병합.
    assert (first["unreached_price"], first["unreached_qty"]) == (10_400, 400)
    assert first["day_extreme"] == 10_350

    live.merge_from(replay)
    assert live.snapshot() == first


def _touch_wall(state, *, minute: int, price: int, qty: int, side: int = 1) -> None:
    """분 `minute` 안에서 벽 하나를 세우고 같은 분 체결로 터치시킨다.

    벽 시각은 `at(minute, 1_000)`, 체결은 `at(minute, 2_000)` — 기록 시퀀스의 정렬 키가
    **벽 시각**이라는 것이 아래 테스트들의 판정축이므로 둘을 다른 값으로 둔다.
    """
    state.ingest_orderbook(t_ms=at(minute, 1_000), asks=[{"price": price, "qty": qty}])
    state.ingest_trade(price=price, side=side, t_ms=at(minute, 2_000))


def test_record_sequence_keeps_morning_records_that_top_three_drops():
    """기록 시퀀스가 `traded_peaks` 와 **다른 축**임을 값으로 고정한다.

    벽이 장중에 커지는 날(여기선 단조 증가)에 최종 크기순 top-3 은 오후 셋만 남긴다.
    최대벽 강도 pane 의 계단은 "그 시점까지의 최대" 라 오전 기록이 있어야 하고,
    그것이 이 계열이 따로 존재하는 이유다.
    """
    state = TodayAskPeakState()
    for i, qty in enumerate([100, 200, 300, 400, 500]):
        _touch_wall(state, minute=10 + i, price=10_000 + i * 10, qty=qty)

    snap = state.snapshot()
    assert [p["qty"] for p in snap["traded_peaks"]] == [500, 400, 300]
    assert [p["qty"] for p in snap["traded_record_peaks"]] == [100, 200, 300, 400, 500]
    assert [p["t_ms"] for p in snap["traded_record_peaks"]] == [
        at(10 + i, 1_000) for i in range(5)
    ]


def test_record_sequence_orders_by_wall_time_not_touch_order():
    """도착 순서 ≠ 시각 순서 — 나중에 닫힌 **앞선** 벽도 기록으로 남는다.

    같은 분에서 큰 벽이 즉시 터치되고(그 분 극값이 이미 지배), 앞선 작은 벽은 나중
    체결이 닫는다. 도착 순서로 running max 를 접으면 앞선 벽이 통째로 사라진다.
    """
    state = TodayAskPeakState()
    state.ingest_orderbook(t_ms=at(10, 1_000), asks=[{"price": 10_100, "qty": 100}])
    state.ingest_trade(price=10_000, side=1, t_ms=at(10, 2_000))   # 10_100 엔 못 닿는다
    # 그 분 극값(10_000)이 이미 지배하는 가격 → 이 벽은 **즉시** 닫힌다.
    state.ingest_orderbook(t_ms=at(10, 3_000), asks=[{"price": 10_000, "qty": 300}])
    state.ingest_trade(price=10_100, side=1, t_ms=at(10, 4_000))   # 이제 앞선 벽이 닫힌다

    assert [
        (p["t_ms"], p["qty"]) for p in state.snapshot()["traded_record_peaks"]
    ] == [(at(10, 1_000), 100), (at(10, 3_000), 300)]


def test_late_arriving_earlier_wall_invalidates_the_records_after_it():
    """뒤늦게 닫힌 **앞선 큰 벽**은 뒤 기록을 소급 무효화한다(순증가 불변식 복구)."""
    state = TodayAskPeakState()
    state.ingest_orderbook(t_ms=at(10, 1_000), asks=[{"price": 10_100, "qty": 300}])
    state.ingest_trade(price=10_000, side=1, t_ms=at(10, 2_000))
    state.ingest_orderbook(t_ms=at(10, 3_000), asks=[{"price": 10_000, "qty": 100}])
    state.ingest_trade(price=10_100, side=1, t_ms=at(10, 4_000))

    # 300 이 먼저 섰으므로 뒤의 100 은 "그 시점까지의 최대" 가 아니다.
    assert [
        (p["t_ms"], p["qty"]) for p in state.snapshot()["traded_record_peaks"]
    ] == [(at(10, 1_000), 300)]


def test_equal_quantity_is_not_a_record_first_arrival_wins():
    """동률은 기록이 아니다 — `_peak_record_sequence`·`foldAskPeak` 의 strict `>` 규약."""
    state = TodayAskPeakState()
    _touch_wall(state, minute=10, price=10_000, qty=400)
    _touch_wall(state, minute=11, price=10_050, qty=400)

    assert [
        (p["t_ms"], p["qty"]) for p in state.snapshot()["traded_record_peaks"]
    ] == [(at(10, 1_000), 400)]


def test_record_sequence_is_capped_from_the_tail():
    """상한은 과거일과 같은 128, 자르는 쪽은 **뒤**다(앞을 자르면 오전이 다시 빈다)."""
    state = TodayAskPeakState()
    for i in range(_TRADED_RECORD_CAP + 5):
        _touch_wall(state, minute=10 + i, price=10_000 + i, qty=100 + i)

    records = state.snapshot()["traded_record_peaks"]
    assert len(records) == _TRADED_RECORD_CAP
    assert records[0]["qty"] == 100                    # 오전이 남는다
    assert records[-1]["qty"] == 100 + _TRADED_RECORD_CAP - 1


def test_merge_from_absorbs_record_sequence_idempotently():
    """재생본의 기록 시퀀스는 **따로** 흡수된다 — `closed_traded`(top-3)엔 오전이 없다.

    장중 재기동이 이 경로다: 라이브 상태는 재기동 이후만 보므로 오전 기록이 통째로
    비고, 그 구멍을 재생본이 메운다.
    """
    replay = TodayAskPeakState()
    for i, qty in enumerate([100, 200, 300, 400, 500]):
        _touch_wall(replay, minute=10 + i, price=10_000 + i * 10, qty=qty)

    live = TodayAskPeakState()
    _touch_wall(live, minute=30, price=10_500, qty=600)

    live.merge_from(replay)
    first = [(p["t_ms"], p["qty"]) for p in live.snapshot()["traded_record_peaks"]]
    assert first == [
        *((at(10 + i, 1_000), 100 * (i + 1)) for i in range(5)),
        (at(30, 1_000), 600),
    ]

    live.merge_from(replay)   # 멱등 — 같은 재생본을 두 번 흡수해도 고정점
    assert [(p["t_ms"], p["qty"]) for p in live.snapshot()["traded_record_peaks"]] == first


def test_bid_record_sequence_uses_the_same_maintenance():
    """매수도 같은 기반 클래스를 쓴다 — 방향은 터치 판정에만 있다."""
    state = TodayBidPeakState()
    for i, qty in enumerate([100, 200, 300, 400]):
        price = 10_000 - i * 10
        state.ingest_orderbook(t_ms=at(10 + i, 1_000), bids=[{"price": price, "qty": qty}])
        state.ingest_trade(price=price, side=1, t_ms=at(10 + i, 2_000))

    assert [p["qty"] for p in state.snapshot()["traded_record_peaks"]] == [100, 200, 300, 400]
