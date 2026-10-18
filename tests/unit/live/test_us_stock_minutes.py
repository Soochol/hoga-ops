import asyncio
import json
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace

import pytest

from hoga.live.kiwoom_rest import Page
from hoga.live.us_daily_candles import NY
from hoga.live.us_stock_minutes import (
    StockMinuteWindow,
    UsStockMinuteService,
    fetch_stock_minutes,
    parse_stock_minute,
)


def row(stamp="20261016185900", day="20261016", close="213.8314"):
    return dict(cntr_tm=stamp, bus_dt=day, cur_prc=close, open_pric="213.83", high_pric="214",
                low_pric="213.77", trde_qty="7079", upd_stkpc_tp="1f", upd_rt="")


def page(rows, more=False, cursor=""):
    return Page(rows=rows, cont=more, next_key=cursor, raw={"return_code": 0, "result_list": rows})


def evidence():
    path = Path(__file__).resolve().parents[3] / "docs/research/2026-10-19-us-stock-minute-probe.json"
    return json.loads(path.read_text())


@pytest.mark.parametrize("symbol", ["NVDA", "AAPL", "KO", "BRKb", "AHT_pd", "AAAA"])
def test_real_first_pages_preserve_native_prices_volume_and_business_date(symbol):
    sample = next(p for p in evidence()["raw_first_pages"] if p["request"]["stk_cd"] == symbol)
    bars = [parse_stock_minute(r) for r in sample["response"]["result_list"]]
    assert len(bars) == 100
    assert bars[0].close == float(sample["response"]["result_list"][0]["cur_prc"])
    assert bars[0].volume == int(sample["response"]["result_list"][0]["trde_qty"])
    assert bars[0].trading_date == "20261016"
    assert all(a.t_ms > b.t_ms for a, b in zip(bars, bars[1:], strict=False))


def test_new_york_interpretation_agrees_with_independent_kst_timestamps():
    for proof in evidence()["timestamp_comparison"]:
        assert proof["overlap"] == proof["matching_fields"]["cur_prc"] == 60
        for sample in proof["samples"]:
            bar = parse_stock_minute(sample["kiwoom"])
            kis = sample["kis"]
            reference = datetime.strptime(kis["kymd"] + kis["khms"], "%Y%m%d%H%M%S")
            # The comparison endpoint explicitly supplies a KST date and clock.
            assert bar.t_ms == int((reference - timedelta(hours=9)).replace(tzinfo=UTC).timestamp() * 1000)


@pytest.mark.parametrize("stamp,expected", [("20261015261000", "2026-10-16T06:10:00+00:00"),
                                            ("20260109261000", "2026-01-10T07:10:00+00:00")])
def test_extended_hours_normalize_next_date_before_applying_dst(stamp, expected):
    bar = parse_stock_minute(row(stamp, stamp[:8]))
    assert datetime.fromtimestamp(bar.t_ms / 1000, UTC).isoformat() == expected
    assert bar.trading_date == stamp[:8]
    # Literal 1f is a provider marker, never coerced into a numeric adjustment.
    assert bar.close == 213.8314 and bar.volume == 7079


@pytest.mark.parametrize("field,value", [("cntr_tm", "20261016480000"), ("cntr_tm", "20261016246000"),
                                       ("cntr_tm", "20260308023000"), ("cntr_tm", "20261016185901"),
                                       ("bus_dt", "20260230"), ("cur_prc", "NaN"),
                                       ("high_pric", "1"), ("trde_qty", "-1")])
def test_bad_vendor_rows_are_not_silently_reinterpreted(field, value):
    with pytest.raises((ValueError, KeyError)):
        parse_stock_minute({**row(), field: value})


@pytest.mark.asyncio
async def test_every_page_uses_governor_and_native_period_with_cursor(monkeypatch):
    calls, submits = [], []

    async def call(api_id, body, *, cont=False, next_key=""):
        calls.append((api_id, dict(body), cont, next_key))
        return page([row("20261016185500" if not cont else "20261016185000")], not cont, "next" if not cont else "")

    client = SimpleNamespace(call=call)

    async def run(scheduler, **kw):
        submits.append(kw)
        return await kw["fetch_fn"](client)

    monkeypatch.setattr("hoga.live.kiwoom_access.run_with_capacity", run)
    result = await fetch_stock_minutes(client, object(), "NASDAQ", "NVDA", "5m", "20261018")
    assert result.pages == 2 and not result.failed and not result.more
    assert [c[2:] for c in calls] == [(False, ""), (True, "next")]
    assert all(c[1] == dict(stex_tp="ND", stk_cd="NVDA", strt_dt="20261018", tic_scope="5",
                            upd_stkpc_tp="0", exrt_appl_tp="0") for c in calls)
    assert all(s["api_id"] == "usa06011" and s["priority"] == "user_visible" for s in submits)
    assert len({s["key"] for s in submits}) == 2
    assert [b.volume for b in result.bars] == [7079, 7079]


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["repeat_key", "stalled", "conflict", "empty_cursor", "upstream"])
async def test_bad_continuations_stop_as_partial_without_fabricated_history(monkeypatch, failure):
    calls = []

    async def run(scheduler, **kw):
        calls.append(kw["key"])
        if len(calls) == 1:
            return page([row()], True, "next")
        if failure == "upstream":
            raise ValueError("bad envelope")
        if failure == "stalled":
            return page([row()], True, "next2")
        if failure == "conflict":
            return page([row("20261016185800"), row(close="213.9")])
        return page([row("20261016185800")], True, "next" if failure == "repeat_key" else "")

    monkeypatch.setattr("hoga.live.kiwoom_access.run_with_capacity", run)
    result = await fetch_stock_minutes(object(), object(), "NASDAQ", "NVDA", "1m", "20261018")
    assert result.failed and result.messages and len(calls) == 2
    assert result.bars[0].t_ms == parse_stock_minute(row()).t_ms
    assert len(result.bars) == 1 and result.cursor == "next"


@pytest.mark.asyncio
async def test_native_window_caps_rows_and_pages_even_if_upstream_has_more(monkeypatch):
    origin = datetime(2026, 10, 16, 18, 59)
    calls = []

    async def run(scheduler, **kw):
        index = len(calls)
        calls.append(kw)
        rows = [row((origin - timedelta(minutes=index * 100 + i)).strftime("%Y%m%d%H%M%S")) for i in range(100)]
        return page(rows, True, f"next-{index}")

    monkeypatch.setattr("hoga.live.kiwoom_access.run_with_capacity", run)
    result = await fetch_stock_minutes(object(), object(), "NASDAQ", "NVDA", "1m", "20261018")
    assert len(result.bars) == 800 and result.pages == len(calls) == 8
    assert result.more and not result.failed
    assert result.bars[-1].t_ms == parse_stock_minute(row()).t_ms


@pytest.mark.asyncio
async def test_snapshot_singleflight_ttl_last_good_and_distinct_exchange_symbol_period(monkeypatch):
    tick, calls, fail = [0.0], [], [False]

    async def fetch(client, scheduler, exchange, symbol, tf, anchor):
        calls.append((exchange, symbol, tf, anchor))
        await asyncio.sleep(0)
        return StockMinuteWindow(bars=[parse_stock_minute(row())] if not fail[0] else [],
                                 pages=1, more=True, failed=fail[0], messages=["failed"] if fail[0] else [])

    monkeypatch.setattr("hoga.live.us_stock_minutes.fetch_stock_minutes", fetch)
    service = UsStockMinuteService(clock=lambda: tick[0], wall_clock=lambda: 123.0,
                                  calendar_now=lambda: datetime(2026, 10, 18, tzinfo=NY))
    client = object()
    a, b = await asyncio.gather(*(service.get("NASDAQ", "NVDA", "1m", client=client) for _ in range(2)))
    assert a == b and len(calls) == 1
    await service.get("NASDAQ", "NVDA", "1m", client=client)
    for ex, sym, tf in [("NYSE", "NVDA", "1m"), ("NASDAQ", "AAPL", "1m"), ("NASDAQ", "NVDA", "5m")]:
        await service.get(ex, sym, tf, client=client)
    assert len(calls) == 4
    tick[0], fail[0] = 61, True
    rows, meta = await service.get("NASDAQ", "NVDA", "1m", client=client)
    assert rows == a[0] and meta.refresh_status == "stale" and meta.last_successful_check_at_ms == 123000
    await service.get("NASDAQ", "NVDA", "1m", client=client)
    assert len(calls) == 5  # failed refresh is backed off too
    assert (await service.get("NASDAQ", "NVDA", "1m", bypass=True))[1].refresh_status == "bypass"
    assert (await service.get("NYSE", "BRKb", "1m"))[1].refresh_status == "unconfigured"
    tick[0], fail[0] = 92, False
    assert (await service.get("NASDAQ", "NVDA", "1m", client=client))[1].refresh_status == "normal"
    await service.aclose()


@pytest.mark.asyncio
async def test_pending_refresh_is_shielded_and_lru_is_bounded(monkeypatch):
    entered, release = asyncio.Event(), asyncio.Event()

    async def fetch(*args):
        entered.set()
        await release.wait()
        return StockMinuteWindow(bars=[parse_stock_minute(row())], pages=1)

    monkeypatch.setattr("hoga.live.us_stock_minutes.fetch_stock_minutes", fetch)
    monkeypatch.setattr("hoga.live.us_stock_minutes.MAX_ENTRIES", 2)
    service = UsStockMinuteService()
    waiter = asyncio.create_task(service.get("NASDAQ", "NVDA", "1m", client=object()))
    await entered.wait()
    waiter.cancel()
    with pytest.raises(asyncio.CancelledError):
        await waiter
    assert not next(iter(service.pending.values())).cancelled()
    release.set()
    await service.get("NASDAQ", "NVDA", "1m", client=object())
    await service.get("NYSE", "BRKb", "1m", client=object())
    await service.get("AMEX", "AAAA", "1m", client=object())
    assert len(service.entries) == 2 and ("NASDAQ", "NVDA", "1m") not in service.entries
    # Shutdown also clears tasks cancelled before their coroutine starts.
    release.clear()
    waiter = asyncio.create_task(service.get("NASDAQ", "AAPL", "1m", client=object()))
    await asyncio.sleep(0)
    await service.aclose()
    with pytest.raises(asyncio.CancelledError):
        await waiter
    assert not service.pending


@pytest.mark.asyncio
@pytest.mark.parametrize("exchange,symbol,tf", [("NASDAQ", "NVDA", tf) for tf in
                         ["1m", "3m", "5m", "10m", "15m", "30m", "60m"]] +
                         [("NYSE", "BRKb", "1m"), ("AMEX", "AAAA", "1m")])
async def test_history_continues_native_cursor_without_rewalking_and_stops_at_end(monkeypatch, exchange, symbol, tf):
    calls = []
    origin = datetime(2026, 10, 16, 18, 59)

    async def run(scheduler, **kw):
        client = SimpleNamespace(call=call)
        return await kw["fetch_fn"](client)

    async def call(api_id, body, *, cont=False, next_key=""):
        offset = int(next_key) if cont else 0
        calls.append((offset, dict(body)))
        rows = []
        for i in range(100):
            dt = origin - timedelta(minutes=(offset + i) * int(tf[:-1]))
            rows.append(row(dt.strftime("%Y%m%d%H%M%S"), dt.strftime("%Y%m%d")))
        return page(rows, offset < 2300, str(offset + 100))

    monkeypatch.setattr("hoga.live.kiwoom_access.run_with_capacity", run)
    service = UsStockMinuteService(calendar_now=lambda: datetime(2026, 10, 18, tzinfo=NY))
    client = object()
    latest, metadata = await service.get(exchange, symbol, tf, client=client)
    token = metadata.next_cursor
    assert len(latest) == 800 and token and metadata.more_available
    older, second = await service.get(exchange, symbol, tf, client=client, cursor=token)
    assert len(older) == 800 and older[-1].t_ms < latest[0].t_ms
    assert second.history_scope == "cursor_history_page" and second.next_cursor
    assert (await service.get(exchange, symbol, tf, client=client, cursor=token))[0] == older
    assert len(calls) == 16  # history cache hit never retraverses latest pages
    final, end = await service.get(exchange, symbol, tf, client=client, cursor=second.next_cursor)
    assert len(final) == 800 and final[-1].t_ms < older[0].t_ms
    assert not end.next_cursor and not end.more_available
    assert [n for n, _ in calls] == list(range(0, 2400, 100))
    assert all(body["tic_scope"] == tf[:-1] and body["strt_dt"] == "20261018" for _, body in calls)
    for ex, sym, period, bad in [(exchange, symbol, tf, token + "x"),
                                  (exchange, symbol + "x", tf, token),
                                  (exchange, symbol, "3m" if tf != "3m" else "1m", token)]:
        with pytest.raises(ValueError, match="새로고침"):
            await service.get(ex, sym, period, client=client, cursor=bad)
    assert len(calls) == 24
    await service.aclose()


@pytest.mark.asyncio
async def test_partial_history_exposes_only_last_valid_cursor_for_safe_resume(monkeypatch):
    calls = []
    origin = datetime(2026, 10, 16, 18, 59)
    fail = [True]

    async def run(scheduler, **kw):
        offset = int(kw["key"][-1] or "0")
        calls.append(offset)
        if offset == 900 and fail[0]:
            raise ValueError("temporary vendor failure")
        rows = [row((origin - timedelta(minutes=offset + i)).strftime("%Y%m%d%H%M%S")) for i in range(100)]
        return page(rows, True, str(offset + 100))

    monkeypatch.setattr("hoga.live.kiwoom_access.run_with_capacity", run)
    service = UsStockMinuteService()
    _, latest = await service.get("NASDAQ", "NVDA", "1m", client=object())
    rows, partial = await service.get("NASDAQ", "NVDA", "1m", client=object(), cursor=latest.next_cursor)
    assert len(rows) == 100 and partial.refresh_status == "partial" and partial.next_cursor
    fail[0] = False
    resumed, metadata = await service.get("NASDAQ", "NVDA", "1m", client=object(), cursor=partial.next_cursor)
    assert len(resumed) == 800 and resumed[-1].t_ms < rows[0].t_ms
    assert metadata.refresh_status == "normal" and calls.count(800) == 1
    await service.aclose()


@pytest.mark.asyncio
async def test_failed_cold_history_can_be_explicitly_retried_without_dropping_latest(monkeypatch):
    calls = []
    fail = [True]
    origin = datetime(2026, 10, 16, 18, 59)

    async def run(scheduler, **kw):
        offset = int(kw["key"][-1] or "0")
        calls.append(offset)
        if offset == 800 and fail[0]:
            raise TimeoutError("temporary")
        rows = [row((origin - timedelta(minutes=offset + i)).strftime("%Y%m%d%H%M%S")) for i in range(100)]
        return page(rows, offset < 1500, str(offset + 100))

    monkeypatch.setattr("hoga.live.kiwoom_access.run_with_capacity", run)
    service = UsStockMinuteService(clock=lambda: 0)
    rows, seed = await service.get("NASDAQ", "NVDA", "1m", client=object())
    empty, failed = await service.get("NASDAQ", "NVDA", "1m", client=object(), cursor=seed.next_cursor)
    assert not empty and failed.refresh_status == "error"
    fail[0] = False
    older, end = await service.get("NASDAQ", "NVDA", "1m", client=object(), cursor=seed.next_cursor)
    assert len(older) == 800 and end.refresh_status == "normal" and not end.next_cursor
    assert calls.count(800) == 2
    assert (await service.get("NASDAQ", "NVDA", "1m", client=object()))[0] == rows
    await service.aclose()
