"""MinuteCandleAggregator 단위 테스트 (키움 WS 실시간 1분봉 합성)."""
from hoga.live.minute_candle_agg import MS_PER_MINUTE, MinuteCandleAggregator
from hoga.live.snapshot import SnapshotKind
from hoga.live.ticks import WsTick

MIN = MS_PER_MINUTE
# 임의의 분 시작 Unix ms(분 격자 정렬). minute index = t_ms // 60_000.
M0 = 1000 * MIN
M1 = 1001 * MIN
M2 = 1002 * MIN


def _tr(code, t_ms, price, qty, *, side=1, cum=None):
    payload = {"trades": [{"t_ms": t_ms, "price": price, "qty": qty, "side": side,
                           "side_source": "kiwoom_ws"}]}
    if cum is not None:
        payload["cum_volume"] = cum
    return WsTick(code=code, t_ms=t_ms, kind=SnapshotKind.TRADE, payload=payload)


def _seal_all(agg):
    out = agg.flush(now_ms=0, seal_all=True)
    return {code: {s.t_ms: s for s in snaps} for code, snaps in out.items()}


def test_ohlc_from_tick_prices():
    agg = MinuteCandleAggregator()
    agg.ingest(_tr("005930", M0 + 1_000, price=100, qty=1))   # open
    agg.ingest(_tr("005930", M0 + 2_000, price=105, qty=1))   # high
    agg.ingest(_tr("005930", M0 + 3_000, price=98, qty=1))    # low
    agg.ingest(_tr("005930", M0 + 4_000, price=101, qty=1))   # close
    bar = _seal_all(agg)["005930"][M0].payload
    assert (bar["open"], bar["high"], bar["low"], bar["close"]) == (100, 105, 98, 101)


def test_volume_cum_delta_self_contained():
    # 직전 봉 종료 누적=100. 이 봉: qty 5(cum 105) + qty 3(cum 108) → 거래량 8.
    agg = MinuteCandleAggregator()
    agg.ingest(_tr("005930", M0 + 1_000, price=100, qty=5, cum=105))
    agg.ingest(_tr("005930", M0 + 2_000, price=102, qty=3, cum=108))
    bar = _seal_all(agg)["005930"][M0].payload
    assert bar["volume"] == 8   # 108 - 105 + 5


def test_volume_falls_back_to_qty_sum_without_cum():
    agg = MinuteCandleAggregator()
    agg.ingest(_tr("005930", M0 + 1_000, price=100, qty=5))
    agg.ingest(_tr("005930", M0 + 2_000, price=102, qty=3))
    bar = _seal_all(agg)["005930"][M0].payload
    assert bar["volume"] == 8


def test_volume_includes_side_zero_auction_qty():
    # 다운샘플러는 side==0을 버리지만, 캔들 거래량은 동시호가 물량을 포함해야 한다.
    agg = MinuteCandleAggregator()
    agg.ingest(_tr("005930", M0 + 500, price=100, qty=99, side=0))
    bar = _seal_all(agg)["005930"][M0].payload
    assert bar["volume"] == 99


def test_flush_seals_only_past_minutes():
    agg = MinuteCandleAggregator()
    agg.ingest(_tr("005930", M0 + 1_000, price=100, qty=1))
    agg.ingest(_tr("005930", M1 + 1_000, price=110, qty=1))   # 진행 중(현재) 분
    # now_ms가 M1 안 → cutoff=1001 → 분1000만 봉인, 분1001은 미봉인.
    out = agg.flush(now_ms=M1 + 5_000)
    stamps = {s.t_ms for s in out["005930"]}
    assert stamps == {M0}


def test_flush_does_not_remove_until_commit():
    agg = MinuteCandleAggregator()
    agg.ingest(_tr("005930", M0 + 1_000, price=100, qty=1))
    first = agg.flush(now_ms=M1 + 5_000)
    assert first["005930"][0].t_ms == M0
    # commit 전이라 다시 flush하면 같은 봉이 또 나온다(durability — append 실패 시 롤).
    again = agg.flush(now_ms=M1 + 5_000)
    assert again["005930"][0].t_ms == M0
    # commit 후엔 사라진다.
    agg.commit("005930", minutes=[M0 // MIN])
    assert agg.flush(now_ms=M1 + 5_000) == {}


def test_seal_all_seals_in_progress_bar():
    agg = MinuteCandleAggregator()
    agg.ingest(_tr("005930", M0 + 1_000, price=100, qty=1))
    # now_ms가 같은 분이라 일반 flush면 미봉인.
    assert agg.flush(now_ms=M0 + 2_000) == {}
    # seal_all이면 진행 중 봉도 봉인(게이트 닫힘 drain).
    out = agg.flush(now_ms=M0 + 2_000, seal_all=True)
    assert out["005930"][0].t_ms == M0


def test_multiple_minutes_sealed_in_order():
    agg = MinuteCandleAggregator()
    agg.ingest(_tr("005930", M0 + 1_000, price=100, qty=1))
    agg.ingest(_tr("005930", M1 + 1_000, price=110, qty=1))
    agg.ingest(_tr("005930", M2 + 1_000, price=120, qty=1))   # 현재 분
    out = agg.flush(now_ms=M2 + 5_000)
    assert [s.t_ms for s in out["005930"]] == [M0, M1]


def test_set_active_codes_evicts_untracked():
    agg = MinuteCandleAggregator()
    agg.ingest(_tr("005930", M0 + 1_000, price=100, qty=1))
    agg.ingest(_tr("000660", M0 + 1_000, price=200, qty=1))
    agg.set_active_codes({"005930"})
    out = _seal_all(agg)
    assert set(out) == {"005930"}


def test_reset_clears_all():
    agg = MinuteCandleAggregator()
    agg.ingest(_tr("005930", M0 + 1_000, price=100, qty=1))
    agg.reset()
    assert agg.flush(now_ms=0, seal_all=True) == {}


def test_multiple_codes_isolated():
    agg = MinuteCandleAggregator()
    agg.ingest(_tr("005930", M0 + 1_000, price=100, qty=5, cum=5))
    agg.ingest(_tr("000660", M0 + 1_000, price=200, qty=7, cum=7))
    out = _seal_all(agg)
    assert out["005930"][M0].payload["close"] == 100
    assert out["000660"][M0].payload["close"] == 200
    assert out["000660"][M0].payload["volume"] == 7


def test_non_trade_ticks_ignored():
    agg = MinuteCandleAggregator()
    agg.ingest(WsTick(code="005930", t_ms=M0 + 1_000, kind=SnapshotKind.OB,
                      payload={"asks": [], "bids": []}))
    assert agg.flush(now_ms=0, seal_all=True) == {}
