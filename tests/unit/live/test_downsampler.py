from hoga.live.downsampler import TickDownsampler
from hoga.live.snapshot import SnapshotKind
from hoga.live.ws_frames import WsTick


def _ob(code, t_ms, tot_ask):
    return WsTick(code=code, t_ms=t_ms, kind=SnapshotKind.OB, payload={
        "code": code, "t_ms": t_ms, "asks": [], "bids": [],
        "total_ask_qty": tot_ask, "total_bid_qty": 0,
    })


def _tr(code, t_ms, qty, side):
    return WsTick(code=code, t_ms=t_ms, kind=SnapshotKind.TRADE, payload={
        "trades": [{"t_ms": t_ms, "price": 100, "qty": qty, "side": side,
                    "side_source": "kis_ws"}],
    })


def _broker(code, t_ms, top_name):
    return WsTick(code=code, t_ms=t_ms, kind=SnapshotKind.BROKER, payload={
        "code": code, "t_ms": t_ms,
        "sell_top": [{"name": top_name, "qty": 10}], "buy_top": [],
    })


def test_state_last_wins_and_flow_sums():
    ds = TickDownsampler()
    ds.ingest(_ob("005930", 1000, tot_ask=111))
    ds.ingest(_ob("005930", 2000, tot_ask=222))      # 마지막 ob가 이김
    ds.ingest(_tr("005930", 1500, qty=5, side=1))
    ds.ingest(_tr("005930", 1600, qty=3, side=-1))
    ds.ingest(_tr("005930", 1700, qty=4, side=1))
    out = ds.flush(now_ms=10_000, phase="regular")
    snaps = {s.kind: s for s in out["005930"]}
    assert snaps[SnapshotKind.OB].payload["total_ask_qty"] == 222
    assert snaps[SnapshotKind.FILL].payload == {
        "buy_qty": 9, "sell_qty": 3, "phase": "regular",
    }


def test_side_zero_excluded_from_fill():
    """§10 fills 분류 동등성 — side==0(단일가/장전)은 합산 금지."""
    ds = TickDownsampler()
    ds.ingest(_tr("005930", 1000, qty=100, side=0))
    out = ds.flush(now_ms=10_000, phase="regular")
    fill = next(s for s in out["005930"] if s.kind is SnapshotKind.FILL)
    assert fill.payload["buy_qty"] == 0 and fill.payload["sell_qty"] == 0


def test_state_carry_when_no_new_tick():
    """§9: 빈 구간 상태형은 직전값 carry (t_ms는 flush 시각으로 갱신)."""
    ds = TickDownsampler()
    ds.ingest(_ob("005930", 1000, tot_ask=111))
    ds.flush(now_ms=10_000, phase="regular")
    out2 = ds.flush(now_ms=20_000, phase="regular")   # 새 tick 없음
    ob = next(s for s in out2["005930"] if s.kind is SnapshotKind.OB)
    assert ob.payload["total_ask_qty"] == 111
    assert ob.t_ms == 20_000


def test_flow_resets_each_window():
    ds = TickDownsampler()
    ds.ingest(_tr("005930", 1000, qty=5, side=1))
    ds.flush(now_ms=10_000, phase="regular")
    out2 = ds.flush(now_ms=20_000, phase="regular")
    fill = next(s for s in out2["005930"] if s.kind is SnapshotKind.FILL)
    assert fill.payload["buy_qty"] == 0                # 합은 리셋(강수량계)


def test_evicted_code_stops_emitting():
    """advisor C: Live Set에서 밀려난 종목의 carry가 유령 스냅샷을 쓰면 안 됨."""
    ds = TickDownsampler()
    ds.ingest(_ob("005930", 1000, tot_ask=111))
    ds.set_active_codes({"000660"})                    # 005930 구독 해제됨
    assert ds.flush(now_ms=10_000, phase="regular") == {}


def test_broker_state_last_wins_and_carries():
    ds = TickDownsampler()
    ds.ingest(_broker("005930", 1000, "A증권"))
    ds.ingest(_broker("005930", 2000, "B증권"))      # 마지막이 이김
    out = ds.flush(now_ms=10_000, phase="regular")
    br = next(s for s in out["005930"] if s.kind is SnapshotKind.BROKER)
    assert br.payload["sell_top"][0]["name"] == "B증권"
    out2 = ds.flush(now_ms=20_000, phase="regular")  # carry
    br2 = next(s for s in out2["005930"] if s.kind is SnapshotKind.BROKER)
    assert br2.payload["sell_top"][0]["name"] == "B증권"
    assert br2.t_ms == 20_000


def test_multi_code_sums_are_isolated():
    ds = TickDownsampler()
    ds.ingest(_tr("005930", 1000, qty=5, side=1))
    ds.ingest(_tr("000660", 1100, qty=7, side=-1))
    out = ds.flush(now_ms=10_000, phase="regular")
    f1 = next(s for s in out["005930"] if s.kind is SnapshotKind.FILL)
    f2 = next(s for s in out["000660"] if s.kind is SnapshotKind.FILL)
    assert (f1.payload["buy_qty"], f1.payload["sell_qty"]) == (5, 0)
    assert (f2.payload["buy_qty"], f2.payload["sell_qty"]) == (0, 7)
