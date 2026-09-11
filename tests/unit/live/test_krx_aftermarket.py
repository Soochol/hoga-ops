"""Launch-day contracts, including storage rather than clock predicates alone."""
import json
from datetime import datetime

import pytest

from hoga.api import symbols
from hoga.api.disk_state import analyze_gaps
from hoga.live import session_gate, stream as stream_module
from hoga.live.buffer import LiveBuffer
from hoga.live.downsampler import TickDownsampler
from hoga.live.kiwoom_vi_state import parse_vi_row
from hoga.live.live_candle_backfill import _effective_session
from hoga.live.promote import _build_meta, _collection_finished
from hoga.live.snapshot import SnapshotKind
from hoga.live.stream import LiveStream, ingest_ask_peak_tick
from hoga.live.ticks import WsTick
from hoga.live.writer import LiveWriter
from hoga.util.timeenc import KST, HogaMs, unix_ms_to_hhmmssms


def at(day: int, hour: int, minute: int = 0) -> int:
    return int(datetime(2026, 9, day, hour, minute, tzinfo=KST).timestamp() * 1000)


def book(t_ms: int, *, code: str = "005930", venue: str = "KRX") -> WsTick:
    return WsTick(code=code, venue=venue, t_ms=t_ms, kind=SnapshotKind.OB, payload={
        "asks": [{"price": 100 + i, "qty": 10} for i in range(10)],
        "bids": [{"price": 99 - i, "qty": 20} for i in range(10)],
        "total_ask_qty": 100, "total_bid_qty": 200,
    })


@pytest.mark.parametrize(("day", "hour", "minute", "expected"), [
    (11, 17, 0, False), (14, 15, 29, True), (14, 15, 30, False),
    (14, 15, 59, False), (14, 16, 0, True), (14, 19, 59, True),
    (14, 20, 0, False), (19, 17, 0, False),
])
def test_capture_gate_respects_launch_and_break(monkeypatch, day, hour, minute, expected):
    monkeypatch.setattr(session_gate, "is_trading_day_now", lambda _: day != 19)
    assert ("KRX" in session_gate.venue_capture_windows(at(day, hour, minute))) is expected


def test_holiday_closes_the_new_window(monkeypatch):
    monkeypatch.setattr(session_gate, "is_trading_day_now", lambda _: False)
    assert not session_gate.venue_capture_windows(at(14, 17))


def test_retired_endpoint_clock_never_opens_after_launch():
    assert session_gate.is_after_hours_single_price_window(at(11, 17))
    assert not session_gate.is_after_hours_single_price_window(at(14, 17))


def test_capture_completion_and_official_close_are_different(monkeypatch):
    monkeypatch.setattr(symbols, "krx_aftermarket_eligibility", lambda _: None)
    for hour, minute in [(15, 35), (17, 0), (20, 4)]:
        now = datetime(2026, 9, 14, hour, minute, tzinfo=KST)
        assert not _collection_finished("20260914", now=now)
    assert _collection_finished("20260914", now=datetime(2026, 9, 14, 20, 5, tzinfo=KST))
    assert _collection_finished("20260911", now=datetime(2026, 9, 11, 15, 35, tzinfo=KST))
    meta = _build_meta("005930", "20260914", [], [], 0)
    assert meta["regular_session_close_ms"] == 153_000_000
    assert meta["indicator_session_close_ms"] == 200_000_000
    assert meta["krx_aftermarket_eligible"] is None


def test_known_excluded_product_does_not_acquire_an_evening_gap(monkeypatch):
    monkeypatch.setattr(symbols, "krx_aftermarket_eligibility", lambda _: False)
    meta = _build_meta("069500", "20260914", [], [], 0)
    assert meta["indicator_session_close_ms"] == 153_000_000
    assert meta["krx_aftermarket_eligible"] is False
    assert _collection_finished(
        "20260914", now=datetime(2026, 9, 14, 15, 35, tzinfo=KST), aftermarket_eligible=False,
    )


def test_effective_sessions_do_not_rewrite_the_past():
    assert _effective_session("20260911", "KRX")["close_ms"] == at(11, 15, 30)
    assert _effective_session("20260914", "KRX")["close_ms"] == at(14, 20)
    assert _effective_session("20260914", "NXT")["open_ms"] == at(14, 8)


def test_gap_analysis_excludes_break_but_covers_last_ten_minutes():
    values = [
        unix_ms_to_hhmmssms("20260914", t)
        for start, end in [(at(14, 9), at(14, 15, 20)), (at(14, 16), at(14, 20))]
        for t in range(start, end, 10_000)
    ]
    bounds = {"session_open_ms": HogaMs(90_000_000), "session_close_ms": HogaMs(200_000_000),
              "continuous_windows": ((90000000, 152000000), (160000000, 200000000))}
    assert not analyze_gaps(values, anchor_edges=True, **bounds).is_partial
    missing_tail = [t for t in values if t < 195_000_000]
    gaps = analyze_gaps(missing_tail, anchor_edges=True, **bounds)
    assert gaps.is_partial
    assert gaps.gap_ranges[-1][1] == 200_000_000


def test_suspended_stream_cannot_carry_regular_book_into_evening():
    ds = TickDownsampler()
    ds.ingest(book(at(14, 15, 29)))
    ds.ingest(book(at(14, 15, 29), venue="NXT"))
    rows = ds.flush(now_ms=at(14, 16), phase="closed")
    assert ("005930", "KRX") not in rows
    assert ("005930", "NXT") in rows
    ds.ingest(book(at(14, 16, 1)))
    assert ("005930", "KRX") in ds.flush(now_ms=at(14, 16, 2), phase="closed")


async def test_opening_tick_reaches_disk_before_periodic_gate_refresh(tmp_path, monkeypatch):
    now = at(14, 16)
    monkeypatch.setattr(stream_module, "_now_ms", lambda: now)
    writer = LiveWriter(tmp_path)
    stream = LiveStream(buffer=LiveBuffer(), writer=writer, date_fn=lambda: "20260914")
    stream._open_venues = frozenset({"NXT", "UN"})
    await stream.on_tick(book(now))
    await stream.flush_once(now_ms=now + 10_000)
    rows = [json.loads(line) for line in (tmp_path / "20260914/KRX/005930.jsonl").read_text().splitlines()]
    assert any(row["kind"] == "ob" for row in rows)


def test_aftermarket_peak_accepts_actual_deep_book():
    class Peak:
        def __init__(self):
            self.times = []

        def ingest_orderbook(self, *, t_ms, asks):
            self.times.append(t_ms)

    state = Peak()
    ingest_ask_peak_tick(book(at(11, 17)), lambda: state)
    ingest_ask_peak_tick(book(at(14, 15, 45)), lambda: state)
    ingest_ask_peak_tick(book(at(14, 17)), lambda: state)
    assert state.times == [at(14, 17)]


def test_vi_extension_is_preserved():
    row = {"item": "005930", "values": {"9068": "4", "9069": "1", "1223": "170000"}}
    parsed = parse_vi_row(row, at(14, 17))
    assert parsed is not None
    assert parsed["kind"] == "extended"
    assert parsed["active"] is True


def test_opening_trades_do_not_use_a_label_from_the_break():
    ds = TickDownsampler()
    ds.ingest(WsTick(code="005930", venue="KRX", t_ms=at(14, 16), kind=SnapshotKind.TRADE,
                     payload={"trades": [{"price": 110, "qty": 5, "side": 1}]}))
    ds.ingest(book(at(14, 16)))
    ds.ingest(book(at(14, 15, 29)))  # delayed regular frame must be ignored
    rows = ds.flush(now_ms=at(14, 16, 1), phase="aftermarket", fill_t_ms=at(14, 15, 59))
    trade = next(r for r in rows[("005930", "KRX")] if r.kind is SnapshotKind.TRADE)
    assert trade.t_ms == at(14, 16)
    assert trade.payload["trades"][0]["qty"] == 5


def test_vi_states_are_isolated_by_exchange():
    from hoga.live.kiwoom_vi_state import KiwoomViState

    state = KiwoomViState()
    values = {"9001": "005930", "9068": "1", "9069": "1", "1223": "170000"}
    state.on_row({"item": "005930", "values": values}, at(14, 17))
    state.on_row({"item": "005930_NX", "values": {**values, "1224": "170200"}}, at(14, 17, 2))
    state.on_row({"item": "005930_AL", "values": {**values, "9068": "4"}}, at(14, 17, 3))
    assert state.get("005930")["active"] is True
    assert state.get("005930_NX")["active"] is False
    assert state.get("005930_AL")["kind"] == "extended"


@pytest.mark.parametrize("minutes", [120, 240])
def test_large_candles_restart_at_the_aftermarket_open(minutes):
    from hoga.api.bundle import downsample_candles
    from hoga.tables.candles import ApiCandle

    rows = [ApiCandle(ts_ms=t, open=p, high=p, low=p, close=p, vol_a=1, vol_b=0)
            for t, p in [(at(14, 15), 100), (at(14, 16), 110), (at(14, 17), 120)]]
    result = downsample_candles(rows, bucket_ms=minutes * 60_000, date="20260914", venue="KRX")
    assert len(result) == 2
    assert result[0].close == 100
    assert result[1].ts_ms == at(14, 16)
    assert result[1].open == 110
    assert result[1].close == 120


def test_quote_polling_remains_open_until_twenty():
    from hoga.live.api import _quote_phase

    assert _quote_phase(datetime(2026, 9, 11, 17, tzinfo=KST), "KRX") == "closed"
    assert _quote_phase(datetime(2026, 9, 14, 17, tzinfo=KST), "KRX") == "open"
    assert _quote_phase(datetime(2026, 9, 14, 20, tzinfo=KST), "KRX") == "closed"


def test_vi_route_selects_the_requested_exchange_and_validates_venue():
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from hoga.live.api import build_router

    seen = []
    app = FastAPI()
    app.include_router(build_router(get_status=lambda: {}, get_buffer=lambda: None,
                                    get_vi_status=lambda key: seen.append(key)))
    with TestClient(app) as client:
        for venue, key in [("KRX", "005930"), ("NXT", "005930_NX"), ("UN", "005930_AL")]:
            response = client.get(f"/api/live/vi-status?code=005930&venue={venue}")
            assert response.status_code == 200
            assert response.json() == {"code": "005930", "vi": None}
            assert seen[-1] == key
        assert client.get("/api/live/vi-status?code=005930&venue=INVALID").status_code == 422


def test_excluded_product_effective_session_stays_at_regular_close(monkeypatch):
    monkeypatch.setattr(symbols, "krx_aftermarket_eligibility", lambda _: False)
    assert _effective_session("20260914", "KRX", code="069500")["close_ms"] == at(14, 15, 30)


@pytest.mark.parametrize("minutes", [120, 240])
def test_parquet_indicators_and_candles_share_the_reopening_grid(tmp_path, minutes):
    import polars as pl

    from hoga.api.bundle import (
        build_depth_heatmap_slice,
        build_fill_strength_slice,
        build_quote_ratio_slice,
        build_trade_volume_poc_slice,
        build_volume_distribution_slice,
        downsample_candles,
    )
    from hoga.api.queries import QueryEngine
    from hoga.api.sources import source_venue_dir
    from hoga.tables.candles import ApiCandle

    day, code, source = "20260914", "005930", "kiwoom_live"
    folder = source_venue_dir(tmp_path / "parquet" / day / code, source, "KRX")
    folder.mkdir(parents=True)
    folder.joinpath("meta.json").write_text(json.dumps({"source":source,"code":code,"date":day,
        "regular_session_open_ms":90000000,"regular_session_close_ms":153000000,
        "indicator_session_open_ms":90000000,"indicator_session_close_ms":200000000,
        "collection_complete":True,"is_partial":False}))
    books, trades, candles = [], [], []
    for hour in (15, 16, 17, 18, 19):
        t = at(14, hour)
        row = {"ts_ms":unix_ms_to_hhmmssms(day,t),"phase":"regular"}
        for i in range(1,11):
            row.update({f"bid_p{i}":100-i,f"ask_p{i}":100+i,f"bid_q{i}":hour,f"ask_q{i}":hour*2})
        books.append(row)
        trades.append({"ts_ms":row["ts_ms"],"side":1,"qty":hour,"price":100})
        candles.append(ApiCandle(ts_ms=t,open=100,high=110,low=90,close=100,vol_a=hour,vol_b=0))
    pl.DataFrame(books).write_parquet(folder / "snapshots.parquet")
    pl.DataFrame(trades).write_parquet(folder / "trades.parquet")
    engine = QueryEngine(tmp_path)
    common = {"code":code,"date":day,"source":source,"venue":"KRX"}
    bounds = {"session_open_ms":90000000,"session_close_ms":200000000}
    bucket_ms = minutes * 60_000
    expected = [c.ts_ms for c in downsample_candles(candles,bucket_ms=bucket_ms,date=day)]
    for cache, today in [(None, None),(engine.indicators_cache,"20260915")]:
        options = {**common,"bucket_ms":bucket_ms,"cache":cache,"today_kst":today}
        ratio = build_quote_ratio_slice(engine,**options,**bounds)
        fill = build_fill_strength_slice(engine,**options)
        heatmap = build_depth_heatmap_slice(engine,**options,**bounds)
        assert [p.t for p in ratio.points] == expected
        assert [p.t for p in fill.points] == expected
        assert [p.t_ms for p in heatmap] == expected
        assert sum(p.buy_qty for p in fill.points) == sum(range(15,20))
        profile = build_volume_distribution_slice(engine,**common,**bounds,range_count=5,
            price_min=90,price_max=110,cache=cache,today_kst=today)
        assert sum(b.qty for b in profile.bins) == sum(range(15,20))
        assert profile.last_trade_ms == at(14,19)
        poc = build_trade_volume_poc_slice(engine,**common,**bounds,range_count=5,
            price_range=(90,110),cache=cache,today_kst=today)
        assert poc is not None


@pytest.mark.parametrize(("venue", "hour", "expected"), [
    ("KRX",17,True),("KRX",20,False),("NXT",8,True),("UN",17,True),
])
def test_ranking_refresh_uses_venue_hours(monkeypatch, venue, hour, expected):
    from hoga.live import kiwoom_rankings as rankings

    monkeypatch.setattr(rankings,"is_trading_day",lambda _:True)
    assert rankings._market_open_now(datetime(2026,9,14,hour,tzinfo=KST),venue) is expected
    monkeypatch.setattr(rankings,"is_trading_day",lambda _:False)
    assert not rankings._market_open_now(datetime(2026,9,14,hour,tzinfo=KST),venue)


def test_evening_signal_settings_round_trip_and_trigger(tmp_path):
    from fastapi.testclient import TestClient

    from hoga.api.app import create_app
    from hoga.live.signal_alert_monitor import SignalAlertMonitor

    client = TestClient(create_app(data_dir=tmp_path))
    rule = {"enabled":True,"start_hhmm":1700,"threshold_pct":100,"use_intra_minute_max":True}
    response = client.patch("/api/signal-alerts/settings",json={"sell_total_renewal":rule})
    assert response.status_code == 200
    assert client.get("/api/signal-alerts/settings").json()["sell_total_renewal"] == rule
    for invalid in (2000, 1960, 859):
        assert client.patch("/api/signal-alerts/settings",
            json={"sell_total_renewal":{**rule,"start_hhmm":invalid}}).status_code == 422
    monitor = SignalAlertMonitor(tmp_path,publish=lambda _:None,date_fn=lambda _:"20260914")
    monitor.set_targets({"005930"})
    assert monitor.ingest_orderbook("005930","삼성전자","KRX",at(14,16),1000,"ws") is None
    assert monitor.ingest_orderbook("005930","삼성전자","KRX",at(14,17),1000,"ws") is not None


@pytest.mark.parametrize(("minutes", "early_hour"), [(120, 14), (240, 12)])
@pytest.mark.parametrize("cached", [False, True])
def test_snapshot_only_peak_keeps_the_same_representatives_as_ratio(tmp_path, minutes, early_hour, cached):
    import polars as pl

    from hoga.api.bundle import build_ask_bid_peak_slices, build_quote_ratio_slice
    from hoga.api.queries import QueryEngine
    from hoga.api.sources import source_venue_dir

    day, code, source = "20260914", "005930", "kiwoom_live"
    folder = source_venue_dir(tmp_path / "parquet" / day / code, source, "KRX")
    folder.mkdir(parents=True)
    (folder / "meta.json").write_text(json.dumps({
        "source": source, "code": code, "date": day,
        "regular_session_open_ms": 90000000, "regular_session_close_ms": 153000000,
        "indicator_session_open_ms": 90000000, "indicator_session_close_ms": 200000000,
        "collection_complete": True, "is_partial": False,
    }))
    rows = []
    for hour, qty in [(early_hour, 1000), (15, 10), (18, 20)]:
        row = {"ts_ms": hour * 10_000_000, "phase": "regular"}
        for level in range(1, 11):
            row.update({f"ask_p{level}": 100 + level, f"bid_p{level}": 100 - level,
                        f"ask_q{level}": qty, f"bid_q{level}": qty})
        rows.append(row)
    pl.DataFrame(rows).write_parquet(folder / "snapshots.parquet")
    engine = QueryEngine(tmp_path)
    options = dict(code=code, date=day, source=source, venue="KRX", bucket_ms=minutes * 60_000,
                   session_open_ms=90000000, session_close_ms=200000000,
                   cache=engine.indicators_cache if cached else None,
                   today_kst="20260915" if cached else None)
    # An ad-hoc regular-only request must not seed the full-day cache.
    build_quote_ratio_slice(engine, **{**options, "session_close_ms": 153000000})
    build_ask_bid_peak_slices(engine, **{**options, "session_close_ms": 153000000})
    for _ in range(2):  # Warm-cache result must preserve the same representative.
        ratio = build_quote_ratio_slice(engine, **options)
        ask, bid = build_ask_bid_peak_slices(engine, **options)
        assert ratio.points[-1].ask_total == 200
        assert max(p.ask_total for p in ratio.points) == 10_000
        assert ask.qty == bid.qty == 1000
        assert ask.t_ms == bid.t_ms == at(14, early_hour)


def test_delayed_open_gap_analysis_uses_explicit_continuous_windows():
    from hoga.live.stock_sessions import krx_continuous_windows

    windows = krx_continuous_windows("20260914", "KRX", 100000000, 200000000)
    values = [unix_ms_to_hhmmssms("20260914", t)
              for lo, hi in [(at(14,10), at(14,15,20)), (at(14,16), at(14,20))]
              for t in range(lo, hi, 10_000)]
    args = dict(session_open_ms=HogaMs(100000000), session_close_ms=HogaMs(200000000),
                continuous_windows=windows, anchor_edges=True)
    result = analyze_gaps(values, **args)
    assert not result.is_partial
    assert result.in_session_count == len(values)
    tail_missing = analyze_gaps([v for v in values if v < 195000000], **args)
    assert tail_missing.gap_ranges[-1][1] == 200000000
    assert krx_continuous_windows("20260911", "KRX", 100000000, 200000000) is None
    assert krx_continuous_windows("20260914", "NXT", 100000000, 200000000) is None


def test_series_gap_guard_uses_promoted_windows(monkeypatch):
    from hoga.api.invariants import StockDateArtifacts, _series_snapshots_no_gaps

    monkeypatch.setattr(symbols, "krx_aftermarket_eligibility", lambda _: True)
    meta = _build_meta("005930", "20260914", [], [], 0)
    assert meta["indicator_continuous_windows"] == [[90000000, 152000000], [160000000, 200000000]]
    values = [unix_ms_to_hhmmssms("20260914", t)
              for lo, hi in [(at(14, 9), at(14, 15, 20)), (at(14, 16), at(14, 20))]
              for t in range(lo, hi, 10_000)]
    assert not _series_snapshots_no_gaps(StockDateArtifacts(meta, snapshot_ts_ms=values))
    # A real interruption inside the final ten minutes must still trip the guard.
    interrupted = [v for v in values if not 195200000 <= v < 195400000]
    violations = _series_snapshots_no_gaps(StockDateArtifacts(meta, snapshot_ts_ms=interrupted))
    assert [v.invariant_id for v in violations] == ["series.snapshots_no_gaps"]


@pytest.mark.parametrize("source", ["kiwoom_live", "hogaplay"])
@pytest.mark.parametrize("old_partial", [False, True])
def test_gap_backfill_persists_windows_even_when_gap_verdict_matches(tmp_path, monkeypatch, source, old_partial):
    import polars as pl

    from hoga.api.invariants import StockDateArtifacts, _series_snapshots_no_gaps
    from hoga.live import meta_backfill

    class AfterCapture(datetime):
        @classmethod
        def now(cls, tz=None):
            return datetime(2026, 9, 16, 12, tzinfo=tz)

    monkeypatch.setattr(meta_backfill, "datetime", AfterCapture)
    folder = tmp_path / "parquet" / "20260914" / "005930" / source
    if source == "kiwoom_live":
        folder /= "KRX"
    folder.mkdir(parents=True)
    windows = [[90000000, 152000000]]
    ranges = [(at(14, 9), at(14, 15, 20))]
    if source == "kiwoom_live":
        windows.append([160000000, 200000000])
        ranges.append((at(14, 16), at(14, 20)))
    values = [int(unix_ms_to_hhmmssms("20260914", t))
              for lo, hi in ranges for t in range(lo, hi, 30_000)]
    pl.DataFrame({"ts_ms": values}).write_parquet(folder / "snapshots.parquet")
    meta = dict(date="20260914", regular_session_open_ms=90000000, regular_session_close_ms=153000000,
                indicator_session_open_ms=90000000,
                indicator_session_close_ms=200000000 if source == "kiwoom_live" else 153000000,
                collection_complete=True, is_partial=old_partial, gap_ranges=[], marker="preserved")
    path = folder / "meta.json"
    path.write_text(json.dumps(meta))
    run = (meta_backfill.backfill_venue_gap_ranges if source == "kiwoom_live"
           else meta_backfill.backfill_hogaplay_meta)
    assert run(tmp_path, dry_run=True).updated == 1
    assert json.loads(path.read_text()) == meta
    assert run(tmp_path).updated == 1
    saved = json.loads(path.read_text())
    assert saved["indicator_continuous_windows"] == windows
    assert saved["is_partial"] is False
    assert saved["collection_complete"] is True
    assert saved["marker"] == "preserved"
    assert not _series_snapshots_no_gaps(StockDateArtifacts(saved, snapshot_ts_ms=values))
    assert run(tmp_path).updated == 0


@pytest.mark.parametrize(("regular_close", "auction_start"), [(123000000, 122000000), (120000000, 115000000)])
def test_early_regular_close_excludes_auction_without_losing_evening(regular_close, auction_start):
    from hoga.live.stock_sessions import krx_continuous_windows

    windows = krx_continuous_windows("20260914", "KRX", 90000000, regular_close)
    assert windows == ((90000000, auction_start),)
    assert krx_continuous_windows(
        "20260914", "KRX", 90000000, 200000000, regular_close_ms=regular_close,
    ) == ((90000000, auction_start), (160000000, 200000000))
    # A clipped query during a normal day is not itself a closing auction.
    assert krx_continuous_windows(
        "20260914", "KRX", 90000000, regular_close, regular_close_ms=153000000,
    ) == ((90000000, regular_close),)


def test_early_close_backfill_and_series_guard_agree(tmp_path):
    import polars as pl

    from hoga.api.invariants import StockDateArtifacts, _series_snapshots_no_gaps
    from hoga.live.meta_backfill import backfill_hogaplay_meta

    folder = tmp_path / "parquet" / "20260914" / "005930" / "hogaplay"
    folder.mkdir(parents=True)
    values = [int(unix_ms_to_hhmmssms("20260914", t)) for t in range(at(14, 9), at(14, 12, 20), 10_000)]
    pl.DataFrame({"ts_ms": values}).write_parquet(folder / "snapshots.parquet")
    meta = dict(date="20260914", regular_session_open_ms=90000000, regular_session_close_ms=123000000,
                collection_complete=True, is_partial=True, gap_ranges=[])
    path = folder / "meta.json"
    path.write_text(json.dumps(meta))
    result = backfill_hogaplay_meta(tmp_path, now=datetime(2026, 9, 16, tzinfo=KST))
    assert result.updated == 1
    saved = json.loads(path.read_text())
    assert saved["is_partial"] is False
    assert saved["indicator_continuous_windows"] == [[90000000, 122000000]]
    assert not _series_snapshots_no_gaps(StockDateArtifacts(saved, snapshot_ts_ms=values))
