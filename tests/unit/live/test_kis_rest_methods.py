"""Stage 2 — KIS REST fetcher method tests (Tasks 2.1–2.6)."""
from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest

from hoga.live.kis_client import KisClient, KisCredentials

FIXTURES = Path("tests/fixtures/kis_mock/responses")


def _fixture(name: str) -> dict:
    return json.loads((FIXTURES / name).read_text())


def _make_client(handler, tmp_path: Path) -> KisClient:
    return KisClient(
        credentials=KisCredentials(app_key="K", app_secret="S", env="real"),
        token_cache_path=tmp_path / "token.json",
        _transport=httpx.MockTransport(handler),
    )


# ---------------------------------------------------------------------------
# Task 2.1: fetch_orderbook
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_fetch_orderbook_parses_real_kis_fixture(tmp_path: Path) -> None:
    sample = _fixture("quote_005930.json")

    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.path == "/oauth2/tokenP":
            return httpx.Response(200, json={"access_token": "T", "expires_in": 86400})
        return httpx.Response(200, json=sample)

    client = _make_client(handler, tmp_path)
    try:
        ob = await client.fetch_orderbook("005930")
        out1 = sample["output1"]
        assert ob.code == "005930"
        assert len(ob.asks) == 10 and len(ob.bids) == 10
        assert ob.asks[0].price == int(out1["askp1"])
        assert ob.asks[0].qty == int(out1["askp_rsqn1"])
        assert ob.bids[0].price == int(out1["bidp1"])
        assert ob.bids[0].qty == int(out1["bidp_rsqn1"])
        assert ob.total_ask_qty == int(out1["total_askp_rsqn"])
        assert ob.total_bid_qty == int(out1["total_bidp_rsqn"])
        assert ob.t_ms > 0
    finally:
        await client.aclose()


# ---------------------------------------------------------------------------
# Task 2.2: fetch_trades (inquire-time-itemconclusion, FHPST01060000)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_fetch_trades_via_timeconclusion_parses_real_fixture(tmp_path: Path) -> None:
    sample = _fixture("timeconclusion_005930.json")

    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.path == "/oauth2/tokenP":
            return httpx.Response(200, json={"access_token": "T", "expires_in": 86400})
        return httpx.Response(200, json=sample)

    client = _make_client(handler, tmp_path)
    try:
        trades = await client.fetch_trades("005930")
        assert len(trades) == len(sample["output2"])
        for trade, row in zip(trades, sample["output2"]):
            assert trade.price == int(row["stck_prpr"])
            assert trade.qty == int(row["cnqn"])
            prpr = int(row["stck_prpr"])
            askp = int(row["askp"])
            bidp = int(row["bidp"])
            expected_side = 1 if prpr >= askp else (-1 if prpr <= bidp else 0)
            hhmmss = row["stck_cntg_hour"]
            hh = int(hhmmss[:2])
            mm = int(hhmmss[2:4])
            in_open_auction = (hh == 8 and mm >= 50) or (hh == 9 and mm == 0)
            in_close_auction = hh == 15 and 20 <= mm < 30
            if in_open_auction or in_close_auction:
                assert trade.side == 2
                assert trade.side_source == "auction"
            else:
                assert trade.side == expected_side
                assert trade.side_source == "inferred"
    finally:
        await client.aclose()


@pytest.mark.asyncio
async def test_classify_side_auction_window(tmp_path: Path) -> None:
    """classify_side correctly labels auction window trades."""
    from hoga.live.kis_client import classify_side, KIS_KST
    from datetime import datetime, date, time as dtime

    # Simulate t_ms for 08:55 KST (open auction)
    dt_open = datetime.combine(date(2026, 5, 27), dtime(8, 55), tzinfo=KIS_KST)
    t_ms_open = int(dt_open.timestamp() * 1000)
    side, src = classify_side(t_ms_open, prpr=309500, askp=309500, bidp=309000)
    assert side == 2
    assert src == "auction"

    # Simulate t_ms for 15:25 KST (close auction)
    dt_close = datetime.combine(date(2026, 5, 27), dtime(15, 25), tzinfo=KIS_KST)
    t_ms_close = int(dt_close.timestamp() * 1000)
    side, src = classify_side(t_ms_close, prpr=309500, askp=309500, bidp=309000)
    assert side == 2
    assert src == "auction"

    # Normal: prpr >= askp → buy
    dt_normal = datetime.combine(date(2026, 5, 27), dtime(10, 0), tzinfo=KIS_KST)
    t_ms_normal = int(dt_normal.timestamp() * 1000)
    side, src = classify_side(t_ms_normal, prpr=309500, askp=309500, bidp=309000)
    assert side == 1
    assert src == "inferred"


# ---------------------------------------------------------------------------
# Task 2.3: fetch_brokers (FHKST01010600)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_fetch_brokers_parses_real_fixture(tmp_path: Path) -> None:
    sample = _fixture("broker_005930.json")

    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.path == "/oauth2/tokenP":
            return httpx.Response(200, json={"access_token": "T", "expires_in": 86400})
        return httpx.Response(200, json=sample)

    client = _make_client(handler, tmp_path)
    try:
        res = await client.fetch_brokers("005930")
        out = sample["output"][0]
        assert res.code == "005930"
        assert len(res.buy_top) == 5
        assert len(res.sell_top) == 5
        # Names are canonicalized at the boundary (hoga.broker_names).
        from hoga.broker_names import canonical

        assert res.buy_top[0].name == canonical(out["shnu_mbcr_name1"])
        assert res.buy_top[0].qty == int(out["total_shnu_qty1"])
        assert res.sell_top[0].name == canonical(out["seln_mbcr_name1"])
        assert res.sell_top[0].qty == int(out["total_seln_qty1"])
        # Concrete transformation: fixture has seln_mbcr_name4="신한증권"
        # which must surface as the canonical "신한투자증권".
        assert out["seln_mbcr_name4"] == "신한증권"
        assert res.sell_top[3].name == "신한투자증권"
    finally:
        await client.aclose()


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


# ---------------------------------------------------------------------------
# Task 2.5: fetch_overtime_orderbook (FHPST02300400)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_fetch_overtime_orderbook_parses_real_fixture(tmp_path: Path) -> None:
    sample = _fixture("overtime_orderbook_005930.json")

    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.path == "/oauth2/tokenP":
            return httpx.Response(200, json={"access_token": "T", "expires_in": 86400})
        return httpx.Response(200, json=sample)

    client = _make_client(handler, tmp_path)
    try:
        ob = await client.fetch_overtime_orderbook("005930")
        out = sample["output"]
        assert ob.code == "005930"
        assert len(ob.asks) == 10 and len(ob.bids) == 10
        assert ob.asks[0].price == int(out["ovtm_untp_askp1"])
        assert ob.asks[0].qty == int(out["ovtm_untp_askp_rsqn1"])
        assert ob.total_ask_qty == int(out["ovtm_total_askp_rsqn"])
        assert ob.total_bid_qty == int(out["ovtm_total_bidp_rsqn"])
    finally:
        await client.aclose()


# ---------------------------------------------------------------------------
# Task 2.6: fetch_overtime_trades (FHPST02310000)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_fetch_overtime_trades_uses_correct_tr_id_and_params(tmp_path: Path) -> None:
    captured: dict = {}
    sample = {
        "rt_cd": "0",
        "msg_cd": "MCA00000",
        "msg1": "OK",
        "output2": [
            {"stck_cntg_hour": "155000", "stck_prpr": "309500", "cnqn": "100"},
            {"stck_cntg_hour": "155030", "stck_prpr": "309500", "cnqn": "200"},
        ],
    }

    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.path == "/oauth2/tokenP":
            return httpx.Response(200, json={"access_token": "T", "expires_in": 86400})
        captured["tr_id"] = req.headers.get("tr_id")
        captured["params"] = dict(req.url.params)
        return httpx.Response(200, json=sample)

    client = _make_client(handler, tmp_path)
    try:
        trades = await client.fetch_overtime_trades("005930")
        assert captured["tr_id"] == "FHPST02310000"
        assert captured["params"].get("fid_hour_cls_code") == "1"
        assert len(trades) == 2
        assert trades[0].price == 309500
        assert trades[0].qty == 100
        # side undefined for overtime closing-price match → 0
        assert trades[0].side == 0
    finally:
        await client.aclose()
