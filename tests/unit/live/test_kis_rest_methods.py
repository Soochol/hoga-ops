"""Stage 2 — KIS REST fetcher method tests (Tasks 2.1–2.6)."""
from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path

import httpx
import pytest

from hoga.live.kis_client import KisClient, KisCredentials
from tests.unit.live._fakes import FakeTokenProvider

FIXTURES = Path("tests/fixtures/kis_mock/responses")


def _fixture(name: str) -> dict:
    return json.loads((FIXTURES / name).read_text())


def _make_client(handler, tmp_path: Path) -> KisClient:
    return KisClient(
        credentials=KisCredentials(app_key="K", app_secret="S", env="real"),
        token_provider=FakeTokenProvider(),
        _transport=httpx.MockTransport(handler),
    )


# ---------------------------------------------------------------------------
# fetch_past_minute_candles (FHKST03010230, 주식일별분봉조회)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_fetch_past_minute_candles_paginates_until_session_open(tmp_path: Path) -> None:
    """KIS returns at most 120 bars per call; the method must page backwards
    from 15:30 until 09:00 is covered, then return ascending by t_ms."""

    def make_row(hh: int, mm: int) -> dict:
        return {
            "stck_bsop_date": "20260526",
            "stck_cntg_hour": f"{hh:02d}{mm:02d}00",
            "stck_oprc": "40000",
            "stck_hgpr": "40100",
            "stck_lwpr": "39900",
            "stck_prpr": "40050",
            "cntg_vol": "100",
        }

    # Build deterministic "120 newest-first bars per anchor" responses for
    # successive anchors. KIS contract: newest-first.
    pages_by_anchor: dict[str, list[dict]] = {
        # 15:30 → 13:31 (120 minutes window, newest first)
        "153000": [make_row(15, m // 60) if False else make_row(13 + (119 - m) // 60, (119 - m) % 60) for m in range(120)],
    }
    # Three deterministic pages. Each newest-first.
    #   Page 1 (anchor 15:30): bars 13:00–14:59 (120). Earliest=13:00; next anchor=12:59:00.
    #   Page 2 (anchor 12:59): bars 11:00–12:59 (120). Earliest=11:00; next anchor=10:59:00.
    #   Page 3 (anchor 10:59): bars 09:00–10:29 (90). Earliest=09:00; stops at session open.
    pages_by_anchor = {
        "153000": [make_row(13 + (119 - i) // 60, (119 - i) % 60) for i in range(120)],
        "125900": [make_row(11 + (119 - i) // 60, (119 - i) % 60) for i in range(120)],
        "105900": [make_row(9 + (89 - i) // 60, (89 - i) % 60) for i in range(90)],
    }
    captured_anchors: list[str] = []

    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.path == "/oauth2/tokenP":
            return httpx.Response(200, json={"access_token": "T", "expires_in": 86400})
        anchor = req.url.params.get("FID_INPUT_HOUR_1")
        captured_anchors.append(anchor)
        rows = pages_by_anchor.get(anchor, [])
        return httpx.Response(200, json={"rt_cd": "0", "msg_cd": "", "msg1": "", "output2": rows})

    client = _make_client(handler, tmp_path)
    try:
        candles = await client.fetch_past_minute_candles("005930", "20260526")
    finally:
        await client.aclose()

    # All three pages were called in order.
    assert captured_anchors[0] == "153000"
    assert captured_anchors[1] == "125900"
    assert captured_anchors[2] == "105900"
    # Each call requested the same date.
    # Result is ascending by t_ms.
    assert all(candles[i].t_ms <= candles[i + 1].t_ms for i in range(len(candles) - 1))
    # No duplicates across pages.
    t_ms_list = [c.t_ms for c in candles]
    assert len(t_ms_list) == len(set(t_ms_list))
    # Got at least the union of three pages' worth.
    assert len(candles) >= 120 + 120 + 90 - 0  # no overlap in our fixtures


@pytest.mark.asyncio
async def test_fetch_past_minute_candles_stops_on_empty_response(tmp_path: Path) -> None:
    """If KIS returns an empty page, pagination must stop (no infinite loop)."""

    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.path == "/oauth2/tokenP":
            return httpx.Response(200, json={"access_token": "T", "expires_in": 86400})
        return httpx.Response(200, json={"rt_cd": "0", "msg_cd": "", "msg1": "", "output2": []})

    client = _make_client(handler, tmp_path)
    try:
        candles = await client.fetch_past_minute_candles("005930", "20260526")
    finally:
        await client.aclose()
    assert candles == []


@pytest.mark.asyncio
async def test_fetch_past_minute_candles_drops_prior_trading_day_on_non_trading_day(
    tmp_path: Path,
) -> None:
    """KIS quirk: a query for Saturday returns Friday's bars instead of [].
    fetch_past_minute_candles must drop any row whose stck_bsop_date doesn't
    match the requested date. Without this filter the caller (the per-date
    accumulator inside /api/live/past-candles) would collect duplicate bars
    under multiple dates and downstream chart libraries would crash on
    non-monotonic time values. Discovered via /investigate 2026-05-28.
    """

    def make_row(date: str, hh: int, mm: int) -> dict:
        return {
            "stck_bsop_date": date,
            "stck_cntg_hour": f"{hh:02d}{mm:02d}00",
            "stck_oprc": "40000",
            "stck_hgpr": "40100",
            "stck_lwpr": "39900",
            "stck_prpr": "40050",
            "cntg_vol": "100",
        }

    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.path == "/oauth2/tokenP":
            return httpx.Response(200, json={"access_token": "T", "expires_in": 86400})
        # Caller requested 20260509 (Saturday) but KIS returns 20260508 bars.
        rows = [make_row("20260508", 15, 30 - i) for i in range(5)]
        return httpx.Response(200, json={"rt_cd": "0", "msg_cd": "", "msg1": "", "output2": rows})

    client = _make_client(handler, tmp_path)
    try:
        candles = await client.fetch_past_minute_candles("005930", "20260509")
    finally:
        await client.aclose()
    assert candles == []
# ----------------------------------------------------------------------
# fetch_past_daily_candles (FHKST03010100, inquire-daily-itemchartprice)
# ----------------------------------------------------------------------

from hoga.live.kis_client import (
    DailyCandleFetchResult,
    DailyInvariantViolation,
    KisRateLimitError,
)


def _daily_row(date_yyyymmdd: str, *, o=100, h=110, l=95, c=105, v=1000) -> dict:
    return {
        "stck_bsop_date": date_yyyymmdd,
        "stck_oprc": str(o),
        "stck_hgpr": str(h),
        "stck_lwpr": str(l),
        "stck_clpr": str(c),
        "acml_vol": str(v),
    }


def _ok_daily_body(rows: list[dict]) -> dict:
    return {"rt_cd": "0", "msg_cd": "", "msg1": "", "output2": rows}



@pytest.mark.asyncio
async def test_fetch_past_daily_clean_response(tmp_path) -> None:
    rows = [_daily_row(f"2024010{i}") for i in range(1, 6)]

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/oauth2/tokenP"):
            return httpx.Response(200, json={"access_token": "T", "expires_in": 86400})
        return httpx.Response(200, json=_ok_daily_body(rows))

    client = KisClient(
        KisCredentials(app_key="k", app_secret="s"),
        token_provider=FakeTokenProvider(),
        _transport=httpx.MockTransport(handler),
    )
    result = await client.fetch_past_daily_candles("005930", "20240101", "20240105")
    assert isinstance(result, DailyCandleFetchResult)
    assert len(result.candles) == 5
    assert result.violations == []
    assert all(result.candles[i].t_ms < result.candles[i + 1].t_ms for i in range(4))


@pytest.mark.asyncio
async def test_fetch_past_daily_drops_close_nonpositive_row(tmp_path) -> None:
    rows = [_daily_row("20240101"), _daily_row("20240102", c=0), _daily_row("20240103")]

    def handler(request):
        if request.url.path.endswith("/oauth2/tokenP"):
            return httpx.Response(200, json={"access_token": "T", "expires_in": 86400})
        return httpx.Response(200, json=_ok_daily_body(rows))

    client = KisClient(
        KisCredentials(app_key="k", app_secret="s"),
        token_provider=FakeTokenProvider(),
        _transport=httpx.MockTransport(handler),
    )
    result = await client.fetch_past_daily_candles("005930", "20240101", "20240103")
    assert len(result.candles) == 2
    assert len(result.violations) == 1
    assert result.violations[0].date_yyyymmdd == "20240102"
    assert result.violations[0].reason == "close_nonpositive"


@pytest.mark.asyncio
async def test_fetch_past_daily_drops_ohlc_inconsistent_row(tmp_path) -> None:
    rows = [_daily_row("20240101", o=120, h=100, l=80, c=110)]

    def handler(request):
        if request.url.path.endswith("/oauth2/tokenP"):
            return httpx.Response(200, json={"access_token": "T", "expires_in": 86400})
        return httpx.Response(200, json=_ok_daily_body(rows))

    client = KisClient(
        KisCredentials(app_key="k", app_secret="s"),
        token_provider=FakeTokenProvider(),
        _transport=httpx.MockTransport(handler),
    )
    result = await client.fetch_past_daily_candles("005930", "20240101", "20240101")
    assert result.candles == []
    assert len(result.violations) == 1
    assert result.violations[0].reason == "ohlc_inconsistent"


@pytest.mark.asyncio
async def test_fetch_past_daily_drops_out_of_range_row(tmp_path) -> None:
    rows = [_daily_row("20240101"), _daily_row("20231231")]

    def handler(request):
        if request.url.path.endswith("/oauth2/tokenP"):
            return httpx.Response(200, json={"access_token": "T", "expires_in": 86400})
        return httpx.Response(200, json=_ok_daily_body(rows))

    client = KisClient(
        KisCredentials(app_key="k", app_secret="s"),
        token_provider=FakeTokenProvider(),
        _transport=httpx.MockTransport(handler),
    )
    result = await client.fetch_past_daily_candles("005930", "20240101", "20240105")
    assert len(result.candles) == 1
    assert len(result.violations) == 1
    assert result.violations[0].reason == "out_of_range"


@pytest.mark.asyncio
async def test_fetch_past_daily_drops_malformed_row(tmp_path) -> None:
    rows = [_daily_row("20240101"), {"stck_bsop_date": ""}]

    def handler(request):
        if request.url.path.endswith("/oauth2/tokenP"):
            return httpx.Response(200, json={"access_token": "T", "expires_in": 86400})
        return httpx.Response(200, json=_ok_daily_body(rows))

    client = KisClient(
        KisCredentials(app_key="k", app_secret="s"),
        token_provider=FakeTokenProvider(),
        _transport=httpx.MockTransport(handler),
    )
    result = await client.fetch_past_daily_candles("005930", "20240101", "20240101")
    assert len(result.candles) == 1
    assert len(result.violations) == 1
    assert result.violations[0].reason == "malformed_row"


@pytest.mark.asyncio
async def test_fetch_past_daily_rate_limit_propagates(tmp_path) -> None:
    def handler(request):
        if request.url.path.endswith("/oauth2/tokenP"):
            return httpx.Response(200, json={"access_token": "T", "expires_in": 86400})
        return httpx.Response(200, json={"rt_cd": "1", "msg_cd": "EGW00201", "msg1": "rate"})

    client = KisClient(
        KisCredentials(app_key="k", app_secret="s"),
        token_provider=FakeTokenProvider(),
        _transport=httpx.MockTransport(handler),
    )
    with pytest.raises(KisRateLimitError):
        await client.fetch_past_daily_candles("005930", "20240101", "20240101")


@pytest.mark.asyncio
async def test_fetch_past_daily_paginates_walk_back(tmp_path) -> None:
    page_responses = [
        _ok_daily_body([_daily_row(f"2024010{i}") for i in [5, 4, 3]]),
        _ok_daily_body([_daily_row(f"2024010{i}") for i in [2, 1]]),
        _ok_daily_body([]),
    ]
    call_count = {"n": 0}

    def handler(request):
        if request.url.path.endswith("/oauth2/tokenP"):
            return httpx.Response(200, json={"access_token": "T", "expires_in": 86400})
        i = call_count["n"]
        call_count["n"] += 1
        return httpx.Response(200, json=page_responses[i])

    client = KisClient(
        KisCredentials(app_key="k", app_secret="s"),
        token_provider=FakeTokenProvider(),
        _transport=httpx.MockTransport(handler),
    )
    result = await client.fetch_past_daily_candles("005930", "20240101", "20240105")
    assert len(result.candles) == 5
    assert all(result.candles[i].t_ms < result.candles[i + 1].t_ms for i in range(4))
    assert call_count["n"] == 3


# ----------------------------------------------------------------------
# fetch_investor_net (FHPTJ04160001, investor-trade-by-stock-daily)
# ----------------------------------------------------------------------

from hoga.live.kis_client import (  # noqa: E402
    KIS_KST,
    InvestorNetFetchResult,
    InvestorNetInvariantViolation,
)


def _investor_row(date_yyyymmdd: str, *, frgn: int, orgn: int) -> dict:
    # KIS investor-trade-by-stock-daily output2 row. We consume net-buy
    # *quantity* fields only (frgn/orgn _ntby_qty); the won-value siblings
    # (_ntby_tr_pbmn) and the individual investor (prsn) are ignored.
    return {
        "stck_bsop_date": date_yyyymmdd,
        "frgn_ntby_qty": str(frgn),
        "orgn_ntby_qty": str(orgn),
        "prsn_ntby_qty": "0",
    }


def _ok_investor_body(rows: list[dict]) -> dict:
    # KIS investor-trade-by-stock-daily returns the daily array under "output2"
    # (output1 is a current-price summary dict). Verified against a live
    # response (code=005930, 2026-05): FID_INPUT_DATE_1 anchors the newest day
    # and rows walk back ~30 trading days.
    return {"rt_cd": "0", "msg_cd": "", "msg1": "", "output1": {}, "output2": rows}


def _investor_handler(rows: list[dict]):
    """Single-page handler: returns the same rows regardless of anchor."""
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/oauth2/tokenP"):
            return httpx.Response(200, json={"access_token": "T", "expires_in": 86400})
        return httpx.Response(200, json=_ok_investor_body(rows))

    return handler


def _investor_walk_handler(pages: dict[str, list[dict]]):
    """Walk-back handler: maps FID_INPUT_DATE_1 anchor → output2 rows.

    Mirrors KIS: each call returns the requested anchor day plus the prior
    ~N trading days; the client re-anchors to (oldest - 1) to page further
    back. Unknown anchors return [] (no more data).
    """
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/oauth2/tokenP"):
            return httpx.Response(200, json={"access_token": "T", "expires_in": 86400})
        anchor = request.url.params.get("FID_INPUT_DATE_1", "")
        return httpx.Response(200, json=_ok_investor_body(pages.get(anchor, [])))

    return handler


@pytest.mark.asyncio
async def test_fetch_investor_net_parses_foreign_and_institution(tmp_path) -> None:
    rows = [
        _investor_row("20240105", frgn=12345, orgn=6789),
        _investor_row("20240104", frgn=-500, orgn=200),
    ]
    client = _make_client(_investor_handler(rows), tmp_path)
    result = await client.fetch_investor_net("005930", "20240104", "20240105")
    assert isinstance(result, InvestorNetFetchResult)
    assert len(result.points) == 2
    # Sorted ASC by t_ms regardless of upstream order.
    assert result.points[0].t_ms < result.points[1].t_ms
    by_date = {
        datetime.fromtimestamp(pt.t_ms / 1000, tz=KIS_KST).strftime("%Y%m%d"): pt
        for pt in result.points
    }
    assert by_date["20240105"].foreign_net == 12345
    assert by_date["20240105"].institution_net == 6789
    assert by_date["20240104"].foreign_net == -500  # net sell stays negative
    assert by_date["20240104"].institution_net == 200


@pytest.mark.asyncio
async def test_fetch_investor_net_anchors_t_ms_at_session_open(tmp_path) -> None:
    # Investor t_ms must use the SAME 09:00 KST anchor as daily candles so the
    # frontend aligns the bars to the candle on the same trading day.
    client = _make_client(
        _investor_handler([_investor_row("20240105", frgn=1, orgn=2)]), tmp_path
    )
    result = await client.fetch_investor_net("005930", "20240105", "20240105")
    expected = int(datetime(2024, 1, 5, 9, 0, tzinfo=KIS_KST).timestamp() * 1000)
    assert result.points[0].t_ms == expected


@pytest.mark.asyncio
async def test_fetch_investor_net_walks_back_across_pages(tmp_path) -> None:
    # Each anchor returns its day + prior days; the client re-anchors to
    # (oldest - 1) and pages backward until `from` is covered.
    pages = {
        "20240110": [_investor_row(d, frgn=1, orgn=2)
                     for d in ("20240110", "20240109", "20240108")],
        "20240107": [_investor_row(d, frgn=1, orgn=2)
                     for d in ("20240107", "20240106", "20240105")],
        "20240104": [_investor_row(d, frgn=1, orgn=2)
                     for d in ("20240104", "20240103")],
    }
    client = _make_client(_investor_walk_handler(pages), tmp_path)
    result = await client.fetch_investor_net("005930", "20240103", "20240110")
    dates = sorted(
        datetime.fromtimestamp(p.t_ms / 1000, tz=KIS_KST).strftime("%Y%m%d")
        for p in result.points
    )
    assert dates == [
        "20240103", "20240104", "20240105", "20240106",
        "20240107", "20240108", "20240109", "20240110",
    ]


@pytest.mark.asyncio
async def test_fetch_investor_net_filters_outside_requested_range(tmp_path) -> None:
    # A page may overshoot the requested `from`; rows older than from are dropped.
    rows = [_investor_row(d, frgn=1, orgn=2)
            for d in ("20240105", "20240104", "20240103", "20240102")]
    client = _make_client(_investor_handler(rows), tmp_path)
    result = await client.fetch_investor_net("005930", "20240104", "20240105")
    dates = sorted(
        datetime.fromtimestamp(p.t_ms / 1000, tz=KIS_KST).strftime("%Y%m%d")
        for p in result.points
    )
    assert dates == ["20240104", "20240105"]


@pytest.mark.asyncio
async def test_fetch_investor_net_empty_output_returns_empty(tmp_path) -> None:
    # No-data response (e.g. a code KIS has no investor rows for) is an empty
    # result, not an error.
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/oauth2/tokenP"):
            return httpx.Response(200, json={"access_token": "T", "expires_in": 86400})
        return httpx.Response(200, json={"rt_cd": "0", "msg_cd": "", "msg1": ""})

    client = _make_client(handler, tmp_path)
    result = await client.fetch_investor_net("005930", "20240101", "20240105")
    assert result.points == []
    assert result.violations == []


@pytest.mark.asyncio
async def test_fetch_investor_net_drops_malformed_row(tmp_path) -> None:
    rows = [_investor_row("20240105", frgn=1, orgn=2), {"stck_bsop_date": ""}]
    client = _make_client(_investor_handler(rows), tmp_path)
    result = await client.fetch_investor_net("005930", "20240105", "20240105")
    assert len(result.points) == 1
    assert len(result.violations) == 1
    assert isinstance(result.violations[0], InvestorNetInvariantViolation)
    assert result.violations[0].reason == "malformed_row"


@pytest.mark.asyncio
async def test_fetch_investor_net_rate_limit_propagates(tmp_path) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/oauth2/tokenP"):
            return httpx.Response(200, json={"access_token": "T", "expires_in": 86400})
        return httpx.Response(200, json={"rt_cd": "1", "msg_cd": "EGW00201", "msg1": "rate"})

    client = _make_client(handler, tmp_path)
    with pytest.raises(KisRateLimitError):
        await client.fetch_investor_net("005930", "20240101", "20240105")
