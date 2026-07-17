from hoga.live.downsampler import TickDownsampler
from hoga.live.snapshot import SnapshotKind
from hoga.live.ticks import WsTick


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


def test_flush_emits_price_grouped_trade_snapshot_for_volume_distribution():
    ds = TickDownsampler()
    ds.ingest(_tr("005930", 1500, qty=5, side=1))
    ds.ingest(_tr("005930", 1600, qty=4, side=1))
    ds.ingest(WsTick(code="005930", t_ms=1700, kind=SnapshotKind.TRADE, payload={
        "trades": [{"t_ms": 1700, "price": 110, "qty": 3, "side": -1, "side_source": "kis_ws"}],
    }))
    ds.ingest(_tr("005930", 1800, qty=99, side=0))

    out = ds.flush(now_ms=20_000, phase="regular", fill_t_ms=10_000)
    snaps = {s.kind: s for s in out["005930"]}

    assert snaps[SnapshotKind.TRADE].t_ms == 10_000
    assert sorted(snaps[SnapshotKind.TRADE].payload["trades"], key=lambda t: (t["price"], t["side"])) == [
        {"t_ms": 10_000, "price": 100, "qty": 9, "side": 1, "side_source": "kis_ws_10s"},
        {"t_ms": 10_000, "price": 110, "qty": 3, "side": -1, "side_source": "kis_ws_10s"},
    ]

    ds.commit_code(
        "005930",
        buy_qty=9,
        sell_qty=3,
        trades=snaps[SnapshotKind.TRADE].payload["trades"],
    )
    out2 = ds.flush(now_ms=30_000, phase="regular", fill_t_ms=20_000)
    assert all(s.kind is not SnapshotKind.TRADE for s in out2["005930"])


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
    """spec 2026-06-08 flush-durability: flush는 더 이상 리셋하지 않는다 —
    commit_code(append 성공 후)가 본 양만큼 뺀다. 윈도별 리셋 동작은 flush +
    commit_code 조합으로 유지(stream.flush_once가 이 순서로 호출)."""
    ds = TickDownsampler()
    ds.ingest(_tr("005930", 1000, qty=5, side=1))
    ds.flush(now_ms=10_000, phase="regular")
    ds.commit_code("005930", buy_qty=5, sell_qty=0)    # append 성공 → 빼기
    out2 = ds.flush(now_ms=20_000, phase="regular")
    fill = next(s for s in out2["005930"] if s.kind is SnapshotKind.FILL)
    assert fill.payload["buy_qty"] == 0                # commit 후 0 (강수량계)


def test_flush_does_not_reset_until_commit():
    """spec flush-durability §2.2: flush는 카운터를 mutate하지 않는다 —
    commit_code만 뺀다. append 실패 시 commit 미호출 → 합 보존 → 다음 윈도 롤."""
    ds = TickDownsampler()
    ds.ingest(_tr("005930", 1000, qty=5, side=1))
    out1 = ds.flush(now_ms=10_000, phase="regular")
    assert next(s for s in out1["005930"]
                if s.kind is SnapshotKind.FILL).payload["buy_qty"] == 5
    # commit 안 함(append 실패 시뮬) → 다음 flush가 같은 합을 다시 본다(보존)
    out2 = ds.flush(now_ms=20_000, phase="regular")
    assert next(s for s in out2["005930"]
                if s.kind is SnapshotKind.FILL).payload["buy_qty"] == 5


def test_commit_code_subtracts_only_committed_amount():
    """spec flush-durability §2.1: commit은 flush가 본 양만 뺀다 — flush와
    commit 사이 도착한 틱(await 창)은 보존된다(zero-on-commit 회귀 방지)."""
    ds = TickDownsampler()
    ds.ingest(_tr("005930", 1000, qty=5, side=1))
    ds.flush(now_ms=10_000, phase="regular")           # 스냅샷 buy=5
    ds.ingest(_tr("005930", 1500, qty=3, side=1))      # await 창에 도착(buy=8)
    ds.commit_code("005930", buy_qty=5, sell_qty=0)    # 본 5만 뺀다
    out2 = ds.flush(now_ms=20_000, phase="regular")
    fill = next(s for s in out2["005930"] if s.kind is SnapshotKind.FILL)
    assert fill.payload["buy_qty"] == 3                # 8 − 5 = 3 (await 틱 보존)


def test_commit_code_noop_for_evicted_code():
    """commit_code가 evict된 코드에 안전(no-op) — set_active_codes 후 잔여 commit."""
    ds = TickDownsampler()
    ds.ingest(_tr("005930", 1000, qty=5, side=1))
    ds.set_active_codes({"000660"})                    # 005930 제거
    ds.commit_code("005930", buy_qty=5, sell_qty=0)    # 예외 없이 no-op


def test_evicted_code_stops_emitting():
    """advisor C: Live Set에서 밀려난 종목의 carry가 유령 스냅샷을 쓰면 안 됨."""
    ds = TickDownsampler()
    ds.ingest(_ob("005930", 1000, tot_ask=111))
    ds.set_active_codes({"000660"})                    # 005930 구독 해제됨
    assert ds.flush(now_ms=10_000, phase="regular") == {}


def test_reset_clears_carry_across_day_boundary():
    """리뷰 C1 벡터 2: reset 후엔 carry가 소멸 — 익일 첫 flush가 어제 종가
    호가창을 쓰지 않는다."""
    ds = TickDownsampler()
    ds.ingest(_ob("005930", 1000, tot_ask=111))
    ds.reset()
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


def test_fill_stamped_with_window_start_label():
    """리뷰 #5: fill 스냅샷은 윈도 시작 라벨(fill_t_ms)로 스탬프 — 마감 시각
    스탬프는 분 경계를 걸친 윈도의 합 전체를 다음 분봉으로 귀속시켜 trades
    폴백·SSE per-trade 버킷팅과 체계적으로 어긋난다. 상태형(ob/broker)은
    '마감 순간의 상태'이므로 now_ms 유지."""
    ds = TickDownsampler()
    ds.ingest(_ob("005930", 1000, tot_ask=111))
    ds.ingest(_tr("005930", 1500, qty=5, side=1))
    out = ds.flush(now_ms=20_000, phase="regular", fill_t_ms=10_000)
    snaps = {s.kind: s for s in out["005930"]}
    assert snaps[SnapshotKind.FILL].t_ms == 10_000   # 윈도 시작
    assert snaps[SnapshotKind.OB].t_ms == 20_000     # 상태형은 마감 시각


def test_multi_code_sums_are_isolated():
    ds = TickDownsampler()
    ds.ingest(_tr("005930", 1000, qty=5, side=1))
    ds.ingest(_tr("000660", 1100, qty=7, side=-1))
    out = ds.flush(now_ms=10_000, phase="regular")
    f1 = next(s for s in out["005930"] if s.kind is SnapshotKind.FILL)
    f2 = next(s for s in out["000660"] if s.kind is SnapshotKind.FILL)
    assert (f1.payload["buy_qty"], f1.payload["sell_qty"]) == (5, 0)
    assert (f2.payload["buy_qty"], f2.payload["sell_qty"]) == (0, 7)
