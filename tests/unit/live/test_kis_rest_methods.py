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
        assert res.buy_top[0].name == out["shnu_mbcr_name1"]
        assert res.buy_top[0].qty == int(out["total_shnu_qty1"])
        assert res.sell_top[0].name == out["seln_mbcr_name1"]
        assert res.sell_top[0].qty == int(out["total_seln_qty1"])
    finally:
        await client.aclose()


# ---------------------------------------------------------------------------
# Task 2.4: fetch_candles (FHKST03010100 daily + FHKST03010200 intraday)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "tf,fixture_name",
    [
        ("D", "candle_d_005930.json"),
        ("1m", "candle_1m_005930.json"),
        # W/M reuse the daily fixture: the KIS schema for daily/weekly/monthly
        # is identical (FHKST03010100 + stck_bsop_date YYYYMMDD), and the
        # test only cares that the period-div parameter is mapped correctly.
        ("W", "candle_d_005930.json"),
        ("M", "candle_d_005930.json"),
    ],
)
async def test_fetch_candles_parses_real_fixture(
    tmp_path: Path, tf: str, fixture_name: str
) -> None:
    sample = _fixture(fixture_name)
    captured: dict = {}

    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.path == "/oauth2/tokenP":
            return httpx.Response(200, json={"access_token": "T", "expires_in": 86400})
        captured["path"] = req.url.path
        captured["params"] = dict(req.url.params)
        return httpx.Response(200, json=sample)

    client = _make_client(handler, tmp_path)
    try:
        candles = await client.fetch_candles("005930", timeframe=tf)
        assert len(candles) == len(sample["output2"])
        if tf in ("D", "W", "M"):
            # All daily-API frames share the same date-range params and only
            # differ in fid_period_div_code (D/W/M).
            assert "fid_input_date_1" in captured["params"]
            assert "fid_input_date_2" in captured["params"]
            assert captured["params"].get("fid_period_div_code") == tf
        else:
            assert captured["params"].get("fid_etc_cls_code") == ""
        first_row = sample["output2"][0]
        first_candle = candles[0]
        assert first_candle.open == int(first_row["stck_oprc"])
        assert first_candle.high == int(first_row["stck_hgpr"])
        assert first_candle.low == int(first_row["stck_lwpr"])
    finally:
        await client.aclose()


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
