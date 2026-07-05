from hoga.live.ask_peak_state import Peak, TodayAskPeakState, TodayBidPeakState


def test_trade_tick_adds_price_only_for_continuous_sides():
    state = TodayAskPeakState()

    state.ingest_trade(price=10_000, side=1)
    state.ingest_trade(price=10_050, side=-1)
    state.ingest_trade(price=10_100, side=0)
    state.ingest_trade(price=10_150, side=2)

    assert state.traded_prices == {10_000, 10_050}


def test_ask_wall_touched_by_later_same_price_tick_moves_to_traded():
    state = TodayAskPeakState()
    state.ingest_orderbook(
        t_ms=1_000,
        asks=[{"price": 10_100, "qty": 500}],
    )

    before = state.snapshot()

    assert before == {
        "coverage": "partial",
        "traded_prices": [],
        "traded_price": None,
        "traded_qty": None,
        "traded_t_ms": None,
        "traded_peaks": [],
        "untraded_price": 10_100,
        "untraded_qty": 500,
        "untraded_t_ms": 1_000,
        "untraded_peaks": [{"price": 10_100, "qty": 500, "t_ms": 1_000}],
        "all_price": 10_100,
        "all_qty": 500,
        "all_t_ms": 1_000,
        "all_peaks": [{"price": 10_100, "qty": 500, "t_ms": 1_000}],
    }

    state.ingest_trade(price=10_100, side=1, t_ms=2_000)

    assert state.snapshot() == {
        "coverage": "partial",
        "traded_prices": [10_100],
        "traded_price": 10_100,
        "traded_qty": 500,
        "traded_t_ms": 1_000,
        "traded_peaks": [{"price": 10_100, "qty": 500, "t_ms": 1_000}],
        "untraded_price": None,
        "untraded_qty": None,
        "untraded_t_ms": None,
        "untraded_peaks": [],
        "all_price": 10_100,
        "all_qty": 500,
        "all_t_ms": 1_000,
        "all_peaks": [{"price": 10_100, "qty": 500, "t_ms": 1_000}],
    }


def test_ask_same_price_later_bigger_wall_stays_untraded_without_later_touch():
    state = TodayAskPeakState()
    state.ingest_orderbook(
        t_ms=1_000,
        asks=[{"price": 10_100, "qty": 500}],
    )
    state.ingest_trade(price=10_100, side=1, t_ms=2_000)
    state.ingest_orderbook(
        t_ms=3_000,
        asks=[{"price": 10_100, "qty": 900}],
    )

    assert state.snapshot() == {
        "coverage": "partial",
        "traded_prices": [10_100],
        "traded_price": 10_100,
        "traded_qty": 500,
        "traded_t_ms": 1_000,
        "traded_peaks": [{"price": 10_100, "qty": 500, "t_ms": 1_000}],
        "untraded_price": 10_100,
        "untraded_qty": 900,
        "untraded_t_ms": 3_000,
        "untraded_peaks": [{"price": 10_100, "qty": 900, "t_ms": 3_000}],
        "all_price": 10_100,
        "all_qty": 900,
        "all_t_ms": 3_000,
        "all_peaks": [
            {"price": 10_100, "qty": 900, "t_ms": 3_000},
            {"price": 10_100, "qty": 500, "t_ms": 1_000},
        ],
    }


def test_bid_same_price_later_bigger_wall_stays_untraded_without_later_touch():
    state = TodayBidPeakState()
    state.ingest_orderbook(
        t_ms=1_000,
        bids=[{"price": 70_000, "qty": 5_000}],
    )
    state.ingest_trade(price=70_000, side=1, t_ms=2_000)
    state.ingest_orderbook(
        t_ms=3_000,
        bids=[{"price": 70_000, "qty": 9_000}],
    )

    assert state.snapshot() == {
        "coverage": "partial",
        "traded_prices": [70_000],
        "traded_price": 70_000,
        "traded_qty": 5_000,
        "traded_t_ms": 1_000,
        "traded_peaks": [{"price": 70_000, "qty": 5_000, "t_ms": 1_000}],
        "untraded_price": 70_000,
        "untraded_qty": 9_000,
        "untraded_t_ms": 3_000,
        "untraded_peaks": [{"price": 70_000, "qty": 9_000, "t_ms": 3_000}],
        "all_price": 70_000,
        "all_qty": 9_000,
        "all_t_ms": 3_000,
        "all_peaks": [
            {"price": 70_000, "qty": 9_000, "t_ms": 3_000},
            {"price": 70_000, "qty": 5_000, "t_ms": 1_000},
        ],
    }


def test_prior_trade_does_not_classify_a_later_wall():
    state = TodayAskPeakState()
    state.ingest_trade(price=10_100, side=1, t_ms=1_000)
    state.ingest_orderbook(
        t_ms=2_000,
        asks=[{"price": 10_100, "qty": 500}],
    )

    assert state.snapshot() == {
        "coverage": "partial",
        "traded_prices": [10_100],
        "traded_price": None,
        "traded_qty": None,
        "traded_t_ms": None,
        "traded_peaks": [],
        "untraded_price": 10_100,
        "untraded_qty": 500,
        "untraded_t_ms": 2_000,
        "untraded_peaks": [{"price": 10_100, "qty": 500, "t_ms": 2_000}],
        "all_price": 10_100,
        "all_qty": 500,
        "all_t_ms": 2_000,
        "all_peaks": [{"price": 10_100, "qty": 500, "t_ms": 2_000}],
    }


def test_ask_same_t_ms_trade_without_seq_touches_wall():
    state = TodayAskPeakState()
    state.ingest_trade(price=10_100, side=1, t_ms=1_000)
    state.ingest_orderbook(
        t_ms=1_000,
        asks=[{"price": 10_100, "qty": 500}],
    )

    assert state.snapshot() == {
        "coverage": "partial",
        "traded_prices": [10_100],
        "traded_price": 10_100,
        "traded_qty": 500,
        "traded_t_ms": 1_000,
        "traded_peaks": [{"price": 10_100, "qty": 500, "t_ms": 1_000}],
        "untraded_price": None,
        "untraded_qty": None,
        "untraded_t_ms": None,
        "untraded_peaks": [],
        "all_price": 10_100,
        "all_qty": 500,
        "all_t_ms": 1_000,
        "all_peaks": [{"price": 10_100, "qty": 500, "t_ms": 1_000}],
    }


def test_bid_same_t_ms_trade_without_seq_touches_wall():
    state = TodayBidPeakState()
    state.ingest_trade(price=70_000, side=1, t_ms=1_000)
    state.ingest_orderbook(
        t_ms=1_000,
        bids=[{"price": 70_000, "qty": 5_000}],
    )

    assert state.snapshot() == {
        "coverage": "partial",
        "traded_prices": [70_000],
        "traded_price": 70_000,
        "traded_qty": 5_000,
        "traded_t_ms": 1_000,
        "traded_peaks": [{"price": 70_000, "qty": 5_000, "t_ms": 1_000}],
        "untraded_price": None,
        "untraded_qty": None,
        "untraded_t_ms": None,
        "untraded_peaks": [],
        "all_price": 70_000,
        "all_qty": 5_000,
        "all_t_ms": 1_000,
        "all_peaks": [{"price": 70_000, "qty": 5_000, "t_ms": 1_000}],
    }


def test_ask_equal_t_ms_and_seq_touches_wall():
    state = TodayAskPeakState()
    state.observed_peak_events[(10_100, 1_000, 7, "ask", "test")] = Peak(
        price=10_100, qty=500, t_ms=1_000, seq=7
    )
    state.ingest_trade(price=10_100, side=1, t_ms=1_000, seq=7)

    assert state.snapshot() == {
        "coverage": "partial",
        "traded_prices": [10_100],
        "traded_price": 10_100,
        "traded_qty": 500,
        "traded_t_ms": 1_000,
        "traded_peaks": [{"price": 10_100, "qty": 500, "t_ms": 1_000}],
        "untraded_price": None,
        "untraded_qty": None,
        "untraded_t_ms": None,
        "untraded_peaks": [],
        "all_price": 10_100,
        "all_qty": 500,
        "all_t_ms": 1_000,
        "all_peaks": [{"price": 10_100, "qty": 500, "t_ms": 1_000}],
    }


def test_bid_equal_t_ms_and_seq_touches_wall():
    state = TodayBidPeakState()
    state.observed_peak_events[(70_000, 1_000, 7, "bid", "test")] = Peak(
        price=70_000, qty=5_000, t_ms=1_000, seq=7
    )
    state.ingest_trade(price=70_000, side=1, t_ms=1_000, seq=7)

    assert state.snapshot() == {
        "coverage": "partial",
        "traded_prices": [70_000],
        "traded_price": 70_000,
        "traded_qty": 5_000,
        "traded_t_ms": 1_000,
        "traded_peaks": [{"price": 70_000, "qty": 5_000, "t_ms": 1_000}],
        "untraded_price": None,
        "untraded_qty": None,
        "untraded_t_ms": None,
        "untraded_peaks": [],
        "all_price": 70_000,
        "all_qty": 5_000,
        "all_t_ms": 1_000,
        "all_peaks": [{"price": 70_000, "qty": 5_000, "t_ms": 1_000}],
    }


def test_side_zero_trade_is_ignored_for_touch_classification():
    state = TodayAskPeakState()
    state.ingest_orderbook(
        t_ms=1_000,
        asks=[{"price": 10_100, "qty": 500}],
    )
    state.ingest_trade(price=10_100, side=0, t_ms=2_000)

    assert state.traded_prices == set()
    assert state.snapshot() == {
        "coverage": "partial",
        "traded_prices": [],
        "traded_price": None,
        "traded_qty": None,
        "traded_t_ms": None,
        "traded_peaks": [],
        "untraded_price": 10_100,
        "untraded_qty": 500,
        "untraded_t_ms": 1_000,
        "untraded_peaks": [{"price": 10_100, "qty": 500, "t_ms": 1_000}],
        "all_price": 10_100,
        "all_qty": 500,
        "all_t_ms": 1_000,
        "all_peaks": [{"price": 10_100, "qty": 500, "t_ms": 1_000}],
    }


def test_snapshot_includes_untraded_legacy_fields_and_ranked_arrays():
    state = TodayAskPeakState()
    state.ingest_orderbook(
        t_ms=1_000,
        asks=[
            {"price": 10_000, "qty": 500},
            {"price": 10_050, "qty": 900},
            {"price": 10_100, "qty": 700},
            {"price": 10_150, "qty": 800},
        ],
    )
    snap = state.snapshot()

    assert snap is not None
    assert snap["untraded_price"] == 10_050
    assert snap["untraded_qty"] == 900
    assert snap["untraded_t_ms"] == 1_000
    assert snap["untraded_peaks"] == [
        {"price": 10_050, "qty": 900, "t_ms": 1_000},
        {"price": 10_150, "qty": 800, "t_ms": 1_000},
        {"price": 10_100, "qty": 700, "t_ms": 1_000},
    ]


def test_snapshot_ranks_and_caps_all_families_to_top_three():
    state = TodayAskPeakState()
    state.ingest_orderbook(
        t_ms=1_000,
        asks=[
            {"price": 10_000, "qty": 400},
            {"price": 10_050, "qty": 800},
            {"price": 10_100, "qty": 700},
            {"price": 10_150, "qty": 600},
            {"price": 10_200, "qty": 500},
            {"price": 10_250, "qty": 300},
        ],
    )
    state.ingest_trade(price=10_100, side=1, t_ms=2_000)
    snap = state.snapshot()

    assert snap is not None
    assert snap["traded_peaks"] == [
        {"price": 10_050, "qty": 800, "t_ms": 1_000},
        {"price": 10_100, "qty": 700, "t_ms": 1_000},
        {"price": 10_000, "qty": 400, "t_ms": 1_000},
    ]
    assert snap["untraded_peaks"] == [
        {"price": 10_150, "qty": 600, "t_ms": 1_000},
        {"price": 10_200, "qty": 500, "t_ms": 1_000},
        {"price": 10_250, "qty": 300, "t_ms": 1_000},
    ]
    assert snap["all_peaks"] == [
        {"price": 10_050, "qty": 800, "t_ms": 1_000},
        {"price": 10_100, "qty": 700, "t_ms": 1_000},
        {"price": 10_150, "qty": 600, "t_ms": 1_000},
    ]
