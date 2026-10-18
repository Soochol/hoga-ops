import asyncio
from datetime import datetime
from types import SimpleNamespace

import pytest

from hoga.live.kis_global_index_candles import fetch_index_daily
from hoga.live.kiwoom_rest import Page
from hoga.live.kiwoom_us_daily_candles import fetch_stock_daily
from hoga.live.us_daily_candles import (
    NY,
    UsDailyBar,
    UsDailyService,
    UsDateRange,
    UsFetchResult,
    completed_through,
    missing_ranges,
    parse_bar,
)


def bar(day, close=120.888):
    return UsDailyBar(trading_date=day, t_ms=0, open=120, high=125, low=119, close=close)


def kis_row(day):
    return dict(
        stck_bsop_date=day,
        ovrs_nmix_oprc="120.0000",
        ovrs_nmix_hgpr="125.0000",
        ovrs_nmix_lwpr="119.0000",
        ovrs_nmix_prpr="120.8880",
        acml_vol="0",
    )


@pytest.mark.parametrize("month,day", [(3, 9), (11, 2)])
def test_new_york_completion_cutoff_handles_dst(month, day):
    before = datetime(2026, month, day, 16, 29, tzinfo=NY)
    after = datetime(2026, month, day, 16, 30, tzinfo=NY)
    assert completed_through(stock=False, now=before) < before.strftime("%Y%m%d")
    assert completed_through(stock=False, now=after) == after.strftime("%Y%m%d")
    assert completed_through(stock=True, now=after) < after.strftime("%Y%m%d")


def test_decimal_parser_and_original_trading_date():
    parsed = parse_bar(
        kis_row("20240607"),
        fields=("stck_bsop_date", "ovrs_nmix_oprc", "ovrs_nmix_hgpr", "ovrs_nmix_lwpr", "ovrs_nmix_prpr", "acml_vol"),
    )
    assert parsed.close == 120.888
    assert parsed.trading_date == "20240607"
    assert parsed.t_ms == 1717718400000  # synthetic same-date 09:00 KST


@pytest.mark.parametrize(
    "field,value", [("ovrs_nmix_prpr", "NaN"), ("ovrs_nmix_oprc", "0"), ("ovrs_nmix_hgpr", "1"), ("acml_vol", "1.2")]
)
def test_parser_rejects_invalid_prices_and_volume(field, value):
    row = {**kis_row("20240607"), field: value}
    with pytest.raises(ValueError):
        parse_bar(
            row,
            fields=(
                "stck_bsop_date",
                "ovrs_nmix_oprc",
                "ovrs_nmix_hgpr",
                "ovrs_nmix_lwpr",
                "ovrs_nmix_prpr",
                "acml_vol",
            ),
        )


def test_coverage_union_does_not_hide_holes():
    spans = [UsDateRange(start="20240603", end="20240604"), UsDateRange(start="20240607", end="20240609")]
    assert [(r.start, r.end) for r in missing_ranges("20240601", "20240610", spans)] == [
        ("20240601", "20240602"),
        ("20240605", "20240606"),
        ("20240610", "20240610"),
    ]


@pytest.mark.asyncio
async def test_kis_short_pages_walk_until_explicit_empty_not_row_count():
    calls = []

    async def page(code, start, end):
        calls.append((code, start, end))
        rows = [kis_row("20240607")] if len(calls) == 1 else [kis_row("20240603")] if len(calls) == 2 else []
        return {"rt_cd": "0", "output2": rows, "output1": {"current_quote": "must never be used"}}

    result = await fetch_index_daily(SimpleNamespace(get_global_index_daily_page=page), "COMP", "20240601", "20240610")
    assert [c[2] for c in calls] == ["20240610", "20240606", "20240602"]
    assert [b.trading_date for b in result.bars] == ["20240603", "20240607"]
    assert not result.truncated
    assert not missing_ranges("20240601", "20240610", result.completed)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "bad",
    [
        {"rt_cd": "1", "output2": []},
        {"rt_cd": "0"},
        {"rt_cd": "0", "output2": [{"wrong": "broken"}]},
        {"rt_cd": "0", "output2": [kis_row("20240611")]},
    ],
)
async def test_kis_invalid_pages_are_not_negative_coverage(bad):
    async def page(*args):
        return bad

    result = await fetch_index_daily(SimpleNamespace(get_global_index_daily_page=page), "SOX", "20240601", "20240610")
    assert not result.completed
    assert result.truncated and result.messages


@pytest.mark.asyncio
async def test_budget_and_error_preserve_only_successfully_walked_pages():
    async def page(*args):
        return {"rt_cd": "0", "output2": [kis_row("20240607")]}

    client = SimpleNamespace(get_global_index_daily_page=page)
    one = await fetch_index_daily(client, "COMP", "20240601", "20240610", max_pages=1)
    assert one.truncated and one.completed == [UsDateRange(start="20240607", end="20240610")]
    repeated = await fetch_index_daily(client, "COMP", "20240601", "20240610")
    assert repeated.truncated and repeated.messages and len(repeated.bars) == 1


@pytest.mark.asyncio
async def test_kiwoom_follows_continuation_headers_through_governor(monkeypatch):
    calls = []
    rows = [
        dict(
            dt="20240607",
            open_pric="119.7700",
            high_pric="121.6917",
            low_pric="118.0220",
            cur_prc="120.8880",
            acc_trde_qty="41238580",
        )
    ]

    async def call(api_id, body, *, cont=False, next_key=""):
        calls.append((api_id, dict(body), cont, next_key))
        data = rows if not cont else []
        return Page(
            rows=data, cont=not cont, next_key="next" if not cont else "", raw={"return_code": 0, "result_list": data}
        )

    submissions = []

    async def run(scheduler, *, fetch_fn, client, **kwargs):
        submissions.append(kwargs)
        return await fetch_fn(client)

    monkeypatch.setattr("hoga.live.kiwoom_access.run_with_capacity", run)
    result = await fetch_stock_daily(SimpleNamespace(call=call), object(), "NASDAQ", "NVDA", "20240601", "20240610")
    assert [(c[2], c[3]) for c in calls] == [(False, ""), (True, "next")]
    assert len(submissions) == 2
    assert calls[0][1]["upd_stkpc_tp"] == "0" and calls[0][1]["exrt_appl_tp"] == "0"
    assert result.bars[0].high == 121.6917
    assert not result.truncated


@pytest.mark.asyncio
async def test_cache_shares_inflight_and_waiter_cancellation_does_not_cancel_owner():
    service = UsDailyService()
    started, finish = asyncio.Event(), asyncio.Event()
    calls = 0

    async def fetch(start, end):
        nonlocal calls
        calls += 1
        started.set()
        await finish.wait()
        return UsFetchResult(bars=[bar("20240607")], completed=[UsDateRange(start=start, end=end)])

    async def get():
        return await service.get(
            "index:SOX", "20240601", "20240610", source="kis", price_basis="index_points", stock=False, fetch=fetch
        )

    first = asyncio.create_task(get())
    await started.wait()
    second = asyncio.create_task(get())
    await asyncio.sleep(0)
    first.cancel()
    with pytest.raises(asyncio.CancelledError):
        await first
    finish.set()
    rows, meta = await second
    assert calls == 1 and len(rows) == 1 and meta.refresh_status == "normal"
    assert not service.pending
    await service.aclose()


@pytest.mark.asyncio
async def test_cache_failure_retains_last_good_timestamp_and_retries_with_backoff():
    now = [0.0]
    service = UsDailyService(clock=lambda: now[0])

    async def good(start, end):
        return UsFetchResult(bars=[bar("20240607")], completed=[UsDateRange(start=start, end=end)])

    kwargs = dict(source="kis", price_basis="index_points", stock=False)
    _, initial = await service.get("SOX", "20240601", "20240610", fetch=good, **kwargs)
    now[0] = 86401
    calls = 0

    async def bad(start, end):
        nonlocal calls
        calls += 1
        return UsFetchResult(messages=["upstream unavailable"], truncated=True)

    rows, stale = await service.get("SOX", "20240601", "20240610", fetch=bad, **kwargs)
    assert len(rows) == 1 and stale.refresh_status == "stale"
    assert stale.last_successful_check_at_ms == initial.last_successful_check_at_ms
    assert stale.missing
    await service.get("SOX", "20240601", "20240610", fetch=bad, **kwargs)
    assert calls == 1
    now[0] += 31
    await service.get("SOX", "20240601", "20240610", fetch=bad, **kwargs)
    assert calls == 2


@pytest.mark.asyncio
async def test_lru_evicts_bars_and_coverage_together_and_bypass_does_not_fetch():
    service = UsDailyService(max_instruments=1)

    async def fetch(start, end):
        return UsFetchResult(bars=[bar("20240607")], completed=[UsDateRange(start=start, end=end)])

    kwargs = dict(source="kiwoom", price_basis="raw", stock=True, fetch=fetch)
    await service.get("us-stock:NASDAQ:AAPL:raw:USD", "20240601", "20240610", **kwargs)
    await service.get("us-stock:NYSE:BRK.B:raw:USD", "20240601", "20240610", **kwargs)
    assert list(service.entries) == ["us-stock:NYSE:BRK.B:raw:USD"]
    rows, meta = await service.get("us-stock:NASDAQ:AAPL:raw:USD", "20240601", "20240610", bypass=True, **kwargs)
    assert not rows and meta.missing and meta.refresh_status == "bypass"


@pytest.mark.asyncio
async def test_recent_coverage_expires_after_five_minutes_but_historical_coverage_does_not(monkeypatch):
    now = [0.0]
    monkeypatch.setattr("hoga.live.us_daily_candles.completed_through", lambda **kw: "20261016")
    service = UsDailyService(clock=lambda: now[0], calendar_now=lambda: datetime(2026, 10, 18, tzinfo=NY))
    calls = []

    async def fetch(start, end):
        calls.append((start, end))
        return UsFetchResult(completed=[UsDateRange(start=start, end=end)])

    kwargs = dict(source="kis", price_basis="index_points", stock=False, fetch=fetch)
    await service.get("COMP", "20000101", "20261016", **kwargs)
    now[0] = 301
    await service.get("COMP", "20000101", "20261016", **kwargs)
    assert len(calls) == 2 and calls[1][0] > "20000101"
    assert calls[1][1] == "20261016"


@pytest.mark.asyncio
async def test_partial_history_requests_resume_only_missing_left_interval():
    service = UsDailyService()
    calls = []

    async def fetch(start, end):
        calls.append((start, end))
        left = "20240607" if len(calls) == 1 else start
        return UsFetchResult(completed=[UsDateRange(start=left, end=end)], truncated=len(calls) == 1)

    kwargs = dict(source="kis", price_basis="index_points", stock=False, fetch=fetch)
    _, partial = await service.get("SOX", "20240601", "20240610", **kwargs)
    assert partial.refresh_status == "partial"
    assert partial.missing == [UsDateRange(start="20240601", end="20240606")]
    _, complete = await service.get("SOX", "20240601", "20240610", **kwargs)
    assert calls[1] == ("20240601", "20240606")
    assert complete.refresh_status == "normal" and not complete.missing


@pytest.mark.asyncio
async def test_us_query_group_and_master_minute_limits_are_independent_of_domestic_trs():
    from hoga.live.kiwoom_capacity import KiwoomCapacityScheduler

    scheduler = KiwoomCapacityScheduler()
    assert scheduler._bucket(0, "usa10099")._interval == 15
    await scheduler._us_bucket(0).acquire()
    assert scheduler._query_available_at(0, "usa06012") > scheduler._query_available_at(0, "ka10081")
    await scheduler.aclose()
