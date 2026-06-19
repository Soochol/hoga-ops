from hoga.live.ask_peak_state import Peak, TodayAskPeakState


def test_trade_tick_adds_price_only_for_continuous_sides():
    state = TodayAskPeakState()

    state.ingest_trade(price=10_000, side=1)
    state.ingest_trade(price=10_050, side=-1)
    state.ingest_trade(price=10_100, side=0)
    state.ingest_trade(price=10_150, side=2)

    assert state.traded_prices == {10_000, 10_050}


def test_orderbook_updates_all_price_peak_from_all_eligible_ask_levels():
    state = TodayAskPeakState()

    state.ingest_orderbook(
        t_ms=1_000,
        asks=[
            {"price": 10_000, "qty": 500},
            {"price": 10_050, "qty": 900},
            {"price": 10_100, "qty": 0},
            {"price": 10_150},
            {"qty": 1_200},
            {"price": -1, "qty": 2_000},
        ],
    )
    state.ingest_orderbook(
        t_ms=2_000,
        asks=[
            {"price": 10_200, "qty": 899},
            {"price": 10_250, "qty": 900},
            {"price": 10_300, "qty": 1_100},
        ],
    )

    assert state.all_peak == Peak(price=10_300, qty=1_100, t_ms=2_000)


def test_orderbook_updates_traded_price_peak_only_for_already_traded_prices():
    state = TodayAskPeakState()
    state.ingest_trade(price=10_000, side=1)

    state.ingest_orderbook(
        t_ms=1_000,
        asks=[
            {"price": 10_000, "qty": 500},
            {"price": 10_050, "qty": 2_000},
        ],
    )

    assert state.all_peak == Peak(price=10_050, qty=2_000, t_ms=1_000)
    assert state.traded_peak == Peak(price=10_000, qty=500, t_ms=1_000)


def test_later_trade_retroactively_promotes_old_orderbook_wall():
    state = TodayAskPeakState()

    state.ingest_orderbook(
        t_ms=1_000,
        asks=[{"price": 10_500, "qty": 5_000}],
    )
    state.ingest_trade(price=10_500, side=1)

    assert state.traded_peak == Peak(price=10_500, qty=5_000, t_ms=1_000)

    state.ingest_orderbook(
        t_ms=2_000,
        asks=[{"price": 10_500, "qty": 4_000}],
    )

    assert state.traded_peak == Peak(price=10_500, qty=5_000, t_ms=1_000)


def test_strict_qty_ties_keep_the_earliest_peak():
    state = TodayAskPeakState()
    state.ingest_trade(price=10_000, side=1)
    state.ingest_trade(price=10_100, side=1)

    state.ingest_orderbook(
        t_ms=1_000,
        asks=[{"price": 10_000, "qty": 700}],
    )
    state.ingest_orderbook(
        t_ms=2_000,
        asks=[{"price": 10_100, "qty": 700}],
    )

    assert state.all_peak == Peak(price=10_000, qty=700, t_ms=1_000)
    assert state.traded_peak == Peak(price=10_000, qty=700, t_ms=1_000)


def test_raw_tick_state_and_close_snapshot_state_can_diverge_by_caller_events():
    raw_state = TodayAskPeakState()
    close_state = TodayAskPeakState()
    for state in (raw_state, close_state):
        state.ingest_trade(price=10_000, side=1)

    raw_state.ingest_orderbook(
        t_ms=1_000,
        asks=[{"price": 10_000, "qty": 3_000}],
    )
    raw_state.ingest_orderbook(
        t_ms=2_000,
        asks=[{"price": 10_000, "qty": 1_000}],
    )
    close_state.ingest_orderbook(
        t_ms=2_000,
        asks=[{"price": 10_000, "qty": 1_000}],
    )

    assert raw_state.traded_peak == Peak(price=10_000, qty=3_000, t_ms=1_000)
    assert close_state.traded_peak == Peak(price=10_000, qty=1_000, t_ms=2_000)


def test_snapshot_returns_none_until_an_eligible_orderbook_peak_exists():
    state = TodayAskPeakState()
    state.ingest_trade(price=10_000, side=1)

    assert state.snapshot() is None

    state.ingest_orderbook(t_ms=1_000, asks=[{"price": 10_050, "qty": 700}])

    assert state.snapshot() == {
        "coverage": "partial",
        "traded_prices": [10_000],
        "traded_price": None,
        "traded_qty": None,
        "traded_t_ms": None,
        "all_price": 10_050,
        "all_qty": 700,
        "all_t_ms": 1_000,
        "all_peaks": [{"price": 10_050, "qty": 700, "t_ms": 1_000}],
    }


def test_snapshot_returns_top_three_all_price_peaks_by_qty():
    state = TodayAskPeakState()

    state.ingest_orderbook(
        t_ms=1_000,
        asks=[
            {"price": 10_000, "qty": 500},
            {"price": 10_050, "qty": 900},
            {"price": 10_100, "qty": 700},
        ],
    )
    state.ingest_orderbook(
        t_ms=2_000,
        asks=[
            {"price": 10_000, "qty": 950},
            {"price": 10_150, "qty": 800},
            {"price": 10_200, "qty": 600},
        ],
    )

    snap = state.snapshot()

    assert snap is not None
    assert snap["all_peaks"] == [
        {"price": 10_000, "qty": 950, "t_ms": 2_000},
        {"price": 10_050, "qty": 900, "t_ms": 1_000},
        {"price": 10_150, "qty": 800, "t_ms": 2_000},
    ]
