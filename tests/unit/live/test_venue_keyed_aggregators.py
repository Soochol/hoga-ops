"""집계 자료구조가 **(code, venue) 로 키잉**된다 — 두 시장이 섞이지 않는다 (ADR-0140 §2).

`split_venue` 가 **bare code** 를 돌려주므로 `tick.code` 만으로는 KRX·NXT 가 구분되지
않는다. 네 구조가 전부 `code` 로만 키잉돼 있었고, `stream.on_tick` 의
`if tick.venue != "KRX": return` **한 줄**이 그 사실을 가리고 있었다 — 그 가드를 여는
순간(PR-F) 조용히 섞인다.

여기 테스트는 **가드 없이** 각 구조를 직접 먹여 분리를 증명한다. 값을 일부러 다르게
줘서, 섞이면 반드시 실패하도록 했다.
"""
from hoga.live.downsampler import TickDownsampler
from hoga.live.minute_candle_agg import MinuteCandleAggregator
from hoga.live.signal_alert_monitor import SignalAlertMonitor
from hoga.live.snapshot import SnapshotKind
from hoga.live.ticks import WsTick

CODE = "005930"
KRX = (CODE, "KRX")
NXT = (CODE, "NXT")


def _ob(venue: str, t_ms: int, tot_ask: int) -> WsTick:
    return WsTick(code=CODE, t_ms=t_ms, kind=SnapshotKind.OB, venue=venue, payload={
        "code": CODE, "t_ms": t_ms, "asks": [], "bids": [],
        "total_ask_qty": tot_ask, "total_bid_qty": 0,
    })


def _tr(venue: str, t_ms: int, price: int, qty: int) -> WsTick:
    return WsTick(code=CODE, t_ms=t_ms, kind=SnapshotKind.TRADE, venue=venue, payload={
        "trades": [{"t_ms": t_ms, "price": price, "qty": qty, "side": 1,
                    "side_source": "kiwoom_ws"}],
    })


def test_downsampler_keeps_venues_apart():
    """KRX 총잔량 100 · NXT 총잔량 900 — 섞이면 나중 도착분이 앞을 덮는다."""
    ds = TickDownsampler()
    ds.ingest(_ob("KRX", 1_000, tot_ask=100))
    ds.ingest(_ob("NXT", 1_100, tot_ask=900))  # 나중 도착 — 덮으면 안 된다

    out = ds.flush(now_ms=10_000, phase="regular")

    assert set(out) == {KRX, NXT}
    ob_of = lambda key: next(  # noqa: E731
        s for s in out[key] if s.kind is SnapshotKind.OB
    ).payload["total_ask_qty"]
    assert ob_of(KRX) == 100
    assert ob_of(NXT) == 900


def test_downsampler_commit_targets_one_venue():
    """commit 은 (code, venue) 하나만 차감한다 — 다른 시장의 합을 건드리면 안 된다."""
    ds = TickDownsampler()
    ds.ingest(_tr("KRX", 1_000, price=100, qty=5))
    ds.ingest(_tr("NXT", 1_000, price=100, qty=7))

    ds.commit_code(CODE, "KRX", buy_qty=5, sell_qty=0)

    out = ds.flush(now_ms=10_000, phase="regular")
    fill_of = lambda key: next(  # noqa: E731
        s for s in out[key] if s.kind is SnapshotKind.FILL
    ).payload["buy_qty"]
    assert fill_of(KRX) == 0
    assert fill_of(NXT) == 7  # 손대지 않았다


def test_candle_agg_keeps_venues_apart():
    """같은 분에 두 시장 체결 — 섞이면 한 봉의 OHLC·거래량이 합쳐진다."""
    agg = MinuteCandleAggregator()
    minute = 1_780_000_000_000 // 60_000 * 60_000
    agg.ingest(_tr("KRX", minute + 1_000, price=100, qty=1))
    agg.ingest(_tr("NXT", minute + 2_000, price=200, qty=3))

    out = agg.flush(now_ms=minute + 120_000)

    assert set(out) == {KRX, NXT}
    assert out[KRX][0].payload["close"] == 100
    assert out[NXT][0].payload["close"] == 200
    assert out[KRX][0].payload["volume"] == 1
    assert out[NXT][0].payload["volume"] == 3


def test_membership_eviction_is_per_code_not_per_venue():
    """Live Set 축출은 **종목 단위** — 코드가 떠나면 그 종목의 모든 venue 를 버린다."""
    ds = TickDownsampler()
    ds.ingest(_ob("KRX", 1_000, tot_ask=100))
    ds.ingest(_ob("NXT", 1_000, tot_ask=900))

    ds.set_active_codes({"000660"})  # CODE 가 빠졌다

    assert ds.flush(now_ms=10_000, phase="regular") == {}


def test_signal_monitor_keeps_venues_apart(tmp_path, monkeypatch):
    """baseline·발동 판정이 시장별로 독립이어야 한다 — 섞이면 총잔량이 합산된다."""
    monkeypatch.setenv("HOGA_DATA_DIR", str(tmp_path))
    published: list[dict] = []
    monitor = SignalAlertMonitor(tmp_path, publish=published.append)
    monitor.set_targets({CODE: "삼성전자"})

    # 장 시작 전 baseline: KRX 1,000 / NXT 100 — 섞이면 baseline 이 서로를 덮는다.
    assert monitor.ingest_orderbook(CODE, "삼성전자", "KRX", 9_00_00, 1_000, "ws") is None
    assert monitor.ingest_orderbook(CODE, "삼성전자", "NXT", 9_00_00, 100, "ws") is None

    # NXT 는 자기 baseline(100) 대비 100% 라 발동, KRX 는 자기 baseline(1,000) 대비
    # 10% 라 미발동 — 상태가 섞였다면 이 대비가 성립하지 않는다.
    krx_event = monitor.ingest_orderbook(CODE, "삼성전자", "KRX", 11_00_00, 100, "ws")
    nxt_event = monitor.ingest_orderbook(CODE, "삼성전자", "NXT", 11_00_00, 100, "ws")
    assert krx_event is None
    assert nxt_event is not None


def test_seal_venues_scopes_forced_sealing_to_the_closing_market_only():
    """KRX 마감 drain 이 **아직 열려 있는 NXT 의 진행 중 봉을 봉인하면 안 된다**.

    ADR-0140 §3 이 저장 창을 KRX 15:30 · NXT·UN 20:00 으로 가른 뒤, 닫힘 drain 은
    `reset(venue)` 을 venue 별로 하면서 **봉인만 전 시장에 걸고 있었다**(`seal_all`).
    그래서 15:30 마다 NXT·UN 의 그 분이 잘리고, 나머지 체결이 새 봉을 만들어 **같은
    분이 두 행**으로 나갔다. 실측 서명은 "분이 끝나기도 전에 나간 봉"(표본 60파일 11건).

    **양방향으로 잰다** — 한 방향만 보면 「항상 봉인」·「절대 봉인 안 함」 어느 쪽으로
    하드코딩해도 초록이 나온다.
    """
    agg = MinuteCandleAggregator()
    minute = 1_780_000_000_000 // 60_000 * 60_000
    agg.ingest(_tr("KRX", minute + 1_000, price=100, qty=1))
    agg.ingest(_tr("NXT", minute + 2_000, price=200, qty=3))

    # 아직 그 분 안이다 — KRX 만 닫힌다.
    out = agg.flush(now_ms=minute + 5_000, seal_venues=frozenset({"KRX"}))

    assert KRX in out          # 닫히는 시장: 진행 중 봉을 봉인한다
    assert NXT not in out      # 열려 있는 시장: 건드리지 않는다
    assert out[KRX][0].payload["close"] == 100
    # NXT 봉은 살아 있어 그 분이 정상적으로 지난 뒤 **한 봉으로** 나간다.
    later = agg.flush(now_ms=minute + 120_000)
    assert later[NXT][0].payload["volume"] == 3


def test_completed_bars_flush_for_every_venue_even_with_no_seal_venues():
    """⚠ venue 스코프는 **진행 중 봉에만** 건다.

    **막는 방향**: 완성 봉까지 `seal_venues` 로 게이트하는 과잉 스코프. 그러면 평시
    flush 가 캔들을 하나도 못 내보내고, 그건 원래 결함보다 훨씬 나쁜 고장이다
    (조각이 아니라 **전량 소실**).
    """
    agg = MinuteCandleAggregator()
    minute = 1_780_000_000_000 // 60_000 * 60_000
    agg.ingest(_tr("KRX", minute + 1_000, price=100, qty=1))
    agg.ingest(_tr("NXT", minute + 2_000, price=200, qty=3))

    out = agg.flush(now_ms=minute + 120_000)  # seal_venues 비어 있음

    assert set(out) == {KRX, NXT}
    assert (out[KRX][0].payload["volume"], out[NXT][0].payload["volume"]) == (1, 3)
