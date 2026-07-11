"""Stage 2 — KIS REST fetcher method tests (Tasks 2.1–2.6)."""
from __future__ import annotations

import json
from datetime import date, datetime
from pathlib import Path

import httpx
import pytest

from hoga.live.api import _candle_to_dict, batched_daily_walkback
from hoga.live.kis_client import KIS_KST, KisClient, KisCredentials, KisTransportError
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
# Task 2.1: fetch_orderbook (FHKST01010200)
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


@pytest.mark.asyncio
@pytest.mark.parametrize("venue,expected_div", [("KRX", "J"), ("NXT", "NX"), ("UN", "UN")])
async def test_fetch_orderbook_threads_venue_div(
    tmp_path: Path, venue: str, expected_div: str
) -> None:
    """venue가 fid_cond_mrkt_div_code로 매핑돼 요청에 실린다(ADR-0099 시분할).
    FHKST01010200이 J/NX/UN 3종을 수용함은 2026-07-11 실측."""
    sample = _fixture("quote_005930.json")
    seen: dict[str, str] = {}

    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.path == "/oauth2/tokenP":
            return httpx.Response(200, json={"access_token": "T", "expires_in": 86400})
        seen["div"] = req.url.params.get("fid_cond_mrkt_div_code", "")
        return httpx.Response(200, json=sample)

    client = _make_client(handler, tmp_path)
    try:
        await client.fetch_orderbook("005930", venue=venue)  # type: ignore[arg-type]
        assert seen["div"] == expected_div
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
    from datetime import date, time as dtime

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
async def test_fetch_past_minute_candles_covers_session_with_parallel_anchors(tmp_path: Path) -> None:
    """앵커(FID_INPUT_HOUR_1)는 시간 주소라 사전 계산·병렬 조회한다 — 앵커-창
    의미론("앵커 이하 최신 120행")의 밀집 하루에서 전 구간이 커버되고 결과는
    오름차순·중복 없음이어야 한다. (구 계약: 순차 커서 워크 — 다음 앵커가
    직전 응답의 최이른 바에 의존. 병렬화로 의도적으로 대체, 2026-07-12.)"""

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

    # 밀집 하루: 09:00~15:30 매 분 = 391바. 핸들러는 KIS 계약대로
    # "앵커 이하 최신 120행, newest-first"를 돌려준다.
    all_minutes = [(9 + m // 60, m % 60) for m in range(0, 391)]
    captured_anchors: list[str] = []

    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.path == "/oauth2/tokenP":
            return httpx.Response(200, json={"access_token": "T", "expires_in": 86400})
        anchor = req.url.params.get("FID_INPUT_HOUR_1")
        captured_anchors.append(anchor)
        a = int(anchor[:2]) * 60 + int(anchor[2:4])
        eligible = [(hh, mm) for hh, mm in all_minutes if hh * 60 + mm <= a]
        newest_first = sorted(eligible, key=lambda t: t[0] * 60 + t[1], reverse=True)[:120]
        rows = [make_row(hh, mm) for hh, mm in newest_first]
        return httpx.Response(200, json={"rt_cd": "0", "msg_cd": "", "msg1": "", "output2": rows})

    client = _make_client(handler, tmp_path)
    try:
        candles = await client.fetch_past_minute_candles("005930", "20260526")
    finally:
        await client.aclose()

    # 사전 계산 앵커 4개가 (병렬이라 순서는 무관하게) 전부 요청됐다.
    assert sorted(captured_anchors, reverse=True) == ["153000", "135000", "121000", "103000"]
    # 밀집 하루 전 구간 커버 + 오름차순 + 중복 없음.
    assert len(candles) == 391
    t_ms_list = [c.t_ms for c in candles]
    assert t_ms_list == sorted(t_ms_list)
    assert len(t_ms_list) == len(set(t_ms_list))


def test_minute_page_anchors_intraday_clamp() -> None:
    """오늘(장중) 조회는 경과 세션과 겹치는 앵커만 유지 — 미래 앵커의 중복
    호출(60초 폴마다 레이트 예산 낭비)을 막되 커버리지는 보존한다."""
    from hoga.live.kis_endpoints import KisEndpointsMixin as M

    # 과거일: 전체 앵커.
    assert M._minute_page_anchors("KRX") == ["153000", "135000", "121000", "103000"]
    # 개장 직후: 첫 창 하나로 충분.
    assert M._minute_page_anchors("KRX", "090300") == ["103000"]
    # 정오: 두 창이 [09:00, 12:00]을 덮는다.
    assert M._minute_page_anchors("KRX", "120000") == ["121000", "103000"]
    # 마감 후 오늘 조회: 전체 앵커와 동일.
    assert M._minute_page_anchors("KRX", "160000") == ["153000", "135000", "121000", "103000"]
    # UN 이른 아침.
    assert M._minute_page_anchors("UN", "090000") == ["100000", "082000"]


@pytest.mark.asyncio
async def test_fetch_past_minute_candles_sparse_day_fully_covered(tmp_path: Path) -> None:
    """성긴 날(개장 30분만 체결): 늦은 앵커 창들은 이른 바까지 물고 내려오므로
    (앵커 이하 최신 120행) 어느 창에서든 수집돼 유실이 없어야 한다."""

    def make_row(hh: int, mm: int) -> dict:
        return {
            "stck_bsop_date": "20260526",
            "stck_cntg_hour": f"{hh:02d}{mm:02d}00",
            "stck_oprc": "40000", "stck_hgpr": "40100",
            "stck_lwpr": "39900", "stck_prpr": "40050", "cntg_vol": "100",
        }

    sparse = [(9, mm) for mm in range(0, 30)]

    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.path == "/oauth2/tokenP":
            return httpx.Response(200, json={"access_token": "T", "expires_in": 86400})
        anchor = req.url.params.get("FID_INPUT_HOUR_1")
        a = int(anchor[:2]) * 60 + int(anchor[2:4])
        eligible = [(hh, mm) for hh, mm in sparse if hh * 60 + mm <= a]
        newest_first = sorted(eligible, key=lambda t: t[0] * 60 + t[1], reverse=True)[:120]
        rows = [make_row(hh, mm) for hh, mm in newest_first]
        return httpx.Response(200, json={"rt_cd": "0", "msg_cd": "", "msg1": "", "output2": rows})

    client = _make_client(handler, tmp_path)
    try:
        candles = await client.fetch_past_minute_candles("005930", "20260526")
    finally:
        await client.aclose()

    assert len(candles) == 30
    t_ms_list = [c.t_ms for c in candles]
    assert t_ms_list == sorted(t_ms_list)
    assert len(t_ms_list) == len(set(t_ms_list))



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


@pytest.mark.asyncio
async def test_fetch_past_minute_candles_threads_nxt_market_div(tmp_path: Path) -> None:
    seen_params: list[dict[str, str]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/oauth2/tokenP":
            return httpx.Response(200, json={"access_token": "T", "expires_in": 86400})
        seen_params.append(dict(request.url.params))
        return httpx.Response(
            200,
            json={
                "rt_cd": "0",
                "msg_cd": "MCA00000",
                "msg1": "정상처리",
                "output2": [],
            },
        )

    client = _make_client(handler, tmp_path)
    try:
        await client.fetch_past_minute_candles("005930", "20260609", venue="NXT")
    finally:
        await client.aclose()

    assert seen_params
    assert seen_params[0]["FID_COND_MRKT_DIV_CODE"] == "NX"
    assert seen_params[0]["FID_INPUT_HOUR_1"] == "200000"


@pytest.mark.asyncio
@pytest.mark.parametrize("venue", ["AUTO", "BAD"])
async def test_fetch_past_minute_candles_rejects_non_concrete_venue(
    tmp_path: Path,
    venue: str,
) -> None:
    data_requests = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal data_requests
        if request.url.path == "/oauth2/tokenP":
            return httpx.Response(200, json={"access_token": "T", "expires_in": 86400})
        data_requests += 1
        return httpx.Response(200, json={"rt_cd": "0", "msg_cd": "", "msg1": "", "output2": []})

    client = _make_client(handler, tmp_path)
    try:
        with pytest.raises(ValueError, match="venue must be one of KRX, NXT, UN"):
            await client.fetch_past_minute_candles("005930", "20260609", venue=venue)  # type: ignore[arg-type]
    finally:
        await client.aclose()

    assert data_requests == 0


@pytest.mark.asyncio
async def test_fetch_past_minute_candles_nxt_empty_bands_harmless(tmp_path: Path) -> None:
    """NXT/UN: 휴장 밴드(빈 창)는 병렬 앵커에선 자연히 빈 페이지일 뿐이다 —
    구 순차 워크의 빈-앵커 점프 테이블 없이도 존재하는 바를 전부 수집한다."""

    def make_row(hh: int, mm: int) -> dict:
        return {
            "stck_bsop_date": "20260609",
            "stck_cntg_hour": f"{hh:02d}{mm:02d}00",
            "stck_oprc": "40000", "stck_hgpr": "40100",
            "stck_lwpr": "39900", "stck_prpr": "40050", "cntg_vol": "100",
        }

    # 15:18·15:19·15:31·15:32에만 체결 — 그 외 시간대(다수 앵커 창)는 빈 밴드.
    bars = [(15, 18), (15, 19), (15, 31), (15, 32)]
    captured_anchors: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/oauth2/tokenP":
            return httpx.Response(200, json={"access_token": "T", "expires_in": 86400})
        anchor = request.url.params.get("FID_INPUT_HOUR_1")
        assert anchor is not None
        captured_anchors.append(anchor)
        a = int(anchor[:2]) * 60 + int(anchor[2:4])
        eligible = [(hh, mm) for hh, mm in bars if hh * 60 + mm <= a]
        newest_first = sorted(eligible, key=lambda t: t[0] * 60 + t[1], reverse=True)[:120]
        return httpx.Response(
            200,
            json={
                "rt_cd": "0",
                "msg_cd": "MCA00000",
                "msg1": "정상처리",
                "output2": [make_row(hh, mm) for hh, mm in newest_first],
            },
        )

    client = _make_client(handler, tmp_path)
    try:
        candles = await client.fetch_past_minute_candles("005930", "20260609", venue="NXT")
    finally:
        await client.aclose()

    # NXT 세션(08:00~20:00) 앵커 8개 전부 병렬 요청.
    assert sorted(captured_anchors, reverse=True) == [
        "200000", "182000", "164000", "150000", "132000", "114000", "100000", "082000",
    ]
    assert [c.t_ms for c in candles] == sorted(c.t_ms for c in candles)
    assert len(candles) == 4
    assert datetime.fromtimestamp(candles[0].t_ms / 1000, tz=KIS_KST).strftime("%H%M%S") == "151800"
    assert datetime.fromtimestamp(candles[-1].t_ms / 1000, tz=KIS_KST).strftime("%H%M%S") == "153200"



@pytest.mark.asyncio
async def test_fetch_past_minute_candles_empty_nxt_day_returns_empty(tmp_path: Path) -> None:
    captured_anchors: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/oauth2/tokenP":
            return httpx.Response(200, json={"access_token": "T", "expires_in": 86400})
        anchor = request.url.params.get("FID_INPUT_HOUR_1")
        assert anchor is not None
        captured_anchors.append(anchor)
        return httpx.Response(
            200,
            json={
                "rt_cd": "0",
                "msg_cd": "MCA00000",
                "msg1": "정상처리",
                "output2": [],
            },
        )

    client = _make_client(handler, tmp_path)
    try:
        candles = await client.fetch_past_minute_candles("005930", "20260609", venue="NXT")
    finally:
        await client.aclose()

    assert candles == []
    # 병렬 앵커: 빈 날에도 사전 계산 앵커 8개가 전부 요청된다(조기 중단 없음 —
    # 커버리지가 개별 응답에 의존하지 않는 것이 병렬화의 전제).
    assert sorted(captured_anchors, reverse=True) == [
        "200000", "182000", "164000", "150000", "132000", "114000", "100000", "082000",
    ]


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
async def test_fetch_past_daily_stops_at_from_without_extra_call(tmp_path) -> None:
    """스펙 2026-06-08 ⑦: 페이지가 요청 시작일(from)까지 도달하면 즉시 종료 —
    형제 fetch_investor_net과 동일 분기. 없으면 빈 응답을 받는 헛 KIS 콜이
    1회 더 나간다(콜드 갭마다 +1, 일봉 차트 열어둔 동안 today 프로브 분당 +1)."""
    calls = {"data": 0}
    rows = [_daily_row(d) for d in ("20240103", "20240102", "20240101")]

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/oauth2/tokenP"):
            return httpx.Response(200, json={"access_token": "T", "expires_in": 86400})
        calls["data"] += 1
        # 한 페이지로 from(20240101)까지 전부 커버 — 더 부를 이유가 없다.
        return httpx.Response(200, json=_ok_daily_body(rows))

    client = KisClient(
        KisCredentials(app_key="k", app_secret="s"),
        token_provider=FakeTokenProvider(),
        _transport=httpx.MockTransport(handler),
    )
    result = await client.fetch_past_daily_candles("005930", "20240101", "20240103")
    assert len(result.candles) == 3
    assert calls["data"] == 1, "from 도달 후 헛 KIS 콜 발생"


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
        # 3번째(빈) 페이지: 스펙 2026-06-08 ⑦의 조기 종료로 더는 요청되지 않는다
        # — 페이지 2의 earliest(0101)가 from(0101)에 도달하므로 즉시 break.
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
    assert call_count["n"] == 2  # 구 3콜 — 빈 확인 콜은 조기 종료(⑦)로 소멸


@pytest.mark.asyncio
async def test_fetch_past_daily_paginates_forward_when_venue_returns_low_side(tmp_path) -> None:
    """Regression: non-KRX daily bars can return the lower side of the requested
    [DATE_1, DATE_2] window. Treating that as "from reached" stopped after the
    first page, so a 2026-06 request rendered only through ~2026-02."""
    pages = {
        ("20260101", "20260619"): [_daily_row(d) for d in ("20260101", "20260102", "20260227")],
        ("20260228", "20260619"): [_daily_row(d) for d in ("20260228", "20260618", "20260619")],
    }
    seen_params: list[tuple[str, str]] = []

    def handler(request):
        if request.url.path.endswith("/oauth2/tokenP"):
            return httpx.Response(200, json={"access_token": "T", "expires_in": 86400})
        key = (
            request.url.params["FID_INPUT_DATE_1"],
            request.url.params["FID_INPUT_DATE_2"],
        )
        seen_params.append(key)
        return httpx.Response(200, json=_ok_daily_body(pages.get(key, [])))

    client = KisClient(
        KisCredentials(app_key="k", app_secret="s"),
        token_provider=FakeTokenProvider(),
        _transport=httpx.MockTransport(handler),
    )
    result = await client.fetch_past_daily_candles("005930", "20260101", "20260619", venue="UN")

    dates = [
        datetime.fromtimestamp(c.t_ms / 1000, tz=KIS_KST).strftime("%Y%m%d")
        for c in result.candles
    ]
    assert seen_params == [("20260101", "20260619"), ("20260228", "20260619")]
    assert dates == ["20260101", "20260102", "20260227", "20260228", "20260618", "20260619"]


@pytest.mark.asyncio
async def test_fetch_past_daily_candles_threads_integrated_market_div(tmp_path: Path) -> None:
    seen_params: list[dict[str, str]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/oauth2/tokenP":
            return httpx.Response(200, json={"access_token": "T", "expires_in": 86400})
        seen_params.append(dict(request.url.params))
        return httpx.Response(
            200,
            json={
                "rt_cd": "0",
                "msg_cd": "MCA00000",
                "msg1": "정상처리",
                "output2": [],
            },
        )

    client = _make_client(handler, tmp_path)
    try:
        await client.fetch_past_daily_candles("005930", "20240101", "20240105", venue="UN")
    finally:
        await client.aclose()

    assert seen_params
    assert seen_params[0]["FID_COND_MRKT_DIV_CODE"] == "UN"


@pytest.mark.asyncio
@pytest.mark.parametrize("venue", ["AUTO", "BAD"])
async def test_fetch_past_daily_candles_rejects_non_concrete_venue(
    tmp_path: Path,
    venue: str,
) -> None:
    data_requests = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal data_requests
        if request.url.path == "/oauth2/tokenP":
            return httpx.Response(200, json={"access_token": "T", "expires_in": 86400})
        data_requests += 1
        return httpx.Response(200, json={"rt_cd": "0", "msg_cd": "", "msg1": "", "output2": []})

    client = _make_client(handler, tmp_path)
    try:
        with pytest.raises(ValueError, match="venue must be one of KRX, NXT, UN"):
            await client.fetch_past_daily_candles("005930", "20240101", "20240105", venue=venue)  # type: ignore[arg-type]
    finally:
        await client.aclose()

    assert data_requests == 0


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


def _estimate_row(slot: str, *, frgn: str, orgn: str, total: str) -> dict:
    return {
        "bsop_hour_gb": slot,
        "frgn_fake_ntby_qty": frgn,
        "orgn_fake_ntby_qty": orgn,
        "sum_fake_ntby_qty": total,
    }


def _ok_estimate_body(rows: list[dict], *, key: str = "output2") -> dict:
    return {"rt_cd": "0", "msg_cd": "MCA00000", "msg1": "정상처리 되었습니다.", key: rows}


def _estimate_handler(rows: list[dict], *, key: str = "output2"):
    async def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/uapi/domestic-stock/v1/quotations/investor-trend-estimate"
        assert request.url.params["MKSC_SHRN_ISCD"] == "005930"
        assert request.headers["tr_id"] == "HHPTJ04160200"
        return httpx.Response(200, json=_ok_estimate_body(rows, key=key))

    return handler


@pytest.mark.anyio
async def test_fetch_investor_trend_estimate_parses_qty_rows(tmp_path) -> None:
    client = _make_client(
        _estimate_handler([
            _estimate_row("0930", frgn="1,234", orgn="-200", total="1,034"),
            _estimate_row("1120", frgn="", orgn="bad", total="0"),
        ]),
        tmp_path,
    )

    rows = await client.fetch_investor_trend_estimate("005930")

    assert [r.slot for r in rows] == ["0930", "1120"]
    assert rows[0].foreign_qty == 1234
    assert rows[0].institution_qty == -200
    assert rows[0].sum_qty == 1034
    assert rows[1].foreign_qty is None
    assert rows[1].institution_qty is None
    assert rows[1].sum_qty == 0


@pytest.mark.anyio
async def test_fetch_investor_trend_estimate_accepts_output_fallback(tmp_path) -> None:
    client = _make_client(
        _estimate_handler([_estimate_row("1430", frgn="5", orgn="6", total="11")], key="output"),
        tmp_path,
    )

    rows = await client.fetch_investor_trend_estimate("005930")

    assert len(rows) == 1
    assert rows[0].slot == "1430"


def _program_trade_row(bsop_hour: str, *, net_qty: str, net_amount: str) -> dict:
    return {
        "bsop_hour": bsop_hour,
        "stck_prpr": "70000",
        "whol_smtn_ntby_qty": net_qty,
        "whol_smtn_ntby_tr_pbmn": net_amount,
        "whol_buy_qty": "1200",
        "whol_seln_qty": "1000",
        "whol_buy_tr_pbmn": "84000000",
        "whol_seln_tr_pbmn": "70000000",
        "whol_ntby_vol_icdc": "200",
        "whol_ntby_tr_pbmn_icdc": "14000000",
    }


def _program_trade_handler(rows: list[dict]):
    async def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/uapi/domestic-stock/v1/quotations/program-trade-by-stock"
        assert request.url.params["FID_COND_MRKT_DIV_CODE"] == "J"
        assert request.url.params["FID_INPUT_ISCD"] == "005930"
        assert request.headers["tr_id"] == "FHPPG04650101"
        return httpx.Response(200, json={
            "rt_cd": "0",
            "msg_cd": "MCA00000",
            "msg1": "정상처리 되었습니다.",
            "output": rows,
        })

    return handler


@pytest.mark.anyio
async def test_fetch_program_trade_by_stock_parses_rows_and_sorts(tmp_path) -> None:
    client = _make_client(
        _program_trade_handler([
            _program_trade_row("090030", net_qty="-2,000", net_amount="-140000000"),
            _program_trade_row("090000", net_qty="1,000", net_amount="70000000"),
            {"bsop_hour": "", "whol_smtn_ntby_qty": "bad"},
        ]),
        tmp_path,
    )

    rows = await client.fetch_program_trade_by_stock("005930")

    assert [r.bsop_hour for r in rows] == ["090000", "090030"]
    assert rows[0].code == "005930"
    assert rows[0].net_qty == 1000
    assert rows[0].net_amount == 70000000
    assert rows[0].buy_qty == 1200
    assert rows[0].sell_qty == 1000
    assert rows[1].net_qty == -2000


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


# ---------------------------------------------------------------------------
# Transport-error full chain (regression: 2026-06-11 foreground daily-candle
# backfill 500). The unit tests in test_kis_client.py prove _do_get_once
# normalizes and the loop retries; these prove the REAL fetch methods (with
# their own paging loops) propagate KisTransportError cleanly — no broad
# except swallows it — and that the route's walk-back closure degrades it to a
# data_warning instead of a 500. fetch_investor_net is a SEPARATE method
# (ADR-0060) so it gets its own propagation test, not symmetry-by-assumption.
# ---------------------------------------------------------------------------
def _disconnecting_client() -> KisClient:
    def handler(req: httpx.Request) -> httpx.Response:
        raise httpx.RemoteProtocolError("Server disconnected without sending a response.")

    return KisClient(
        credentials=KisCredentials(app_key="K", app_secret="S", env="real"),
        token_provider=FakeTokenProvider(),
        _transport=httpx.MockTransport(handler),
        _transport_retry_backoff=(0.0,),  # instant retry, then exhaust
    )


@pytest.mark.asyncio
async def test_fetch_past_daily_candles_propagates_transport_error() -> None:
    """The real daily paging loop must let KisTransportError out — a broad
    except here would re-bury the 500 the client just fixed."""
    client = _disconnecting_client()
    try:
        with pytest.raises(KisTransportError) as exc_info:
            await client.fetch_past_daily_candles("005930", "20240101", "20240105")
        assert exc_info.value.msg_cd == "TRANSPORT/RemoteProtocolError"
    finally:
        await client.aclose()


@pytest.mark.asyncio
async def test_fetch_investor_net_propagates_transport_error() -> None:
    """Investor walk-back is a distinct method (ADR-0060) and the original
    EGW00201s were on its endpoint — verify it propagates the same, not by
    assuming symmetry with the daily path."""
    client = _disconnecting_client()
    try:
        with pytest.raises(KisTransportError) as exc_info:
            await client.fetch_investor_net("005930", "20240101", "20240105")
        assert exc_info.value.msg_cd == "TRANSPORT/RemoteProtocolError"
    finally:
        await client.aclose()


class _NoCache:
    """Minimal cache: no batches, today skipped. Exercises only the gap loop."""

    def list_batches(self, code: str):
        return []

    def append_batch(self, code, frm, to, rows) -> None:
        pass

    def get_today(self, code: str):
        return ("negative", None)

    def store_today(self, code, bar) -> None:
        pass


@pytest.mark.asyncio
async def test_transport_error_full_chain_degrades_in_walkback() -> None:
    """End-to-end of the user's symptom: mock transport disconnects → real
    fetch_past_daily_candles → the route's real fetch_batch closure →
    batched_daily_walkback. Must return normally with a kis_transport
    data_warning, NOT raise (which is what surfaced as the route 500)."""
    client = _disconnecting_client()

    # Faithful replica of _get_past_daily_candles' closure (api.py).
    async def fetch_batch(code_: str, from_s: str, to_s: str):
        result = await client.fetch_past_daily_candles(
            code_, from_s, to_s, foreground=True
        )
        return [_candle_to_dict(c) for c in result.candles], result.violations

    try:
        out = await batched_daily_walkback(
            cache=_NoCache(), fetch_batch=fetch_batch, output_key="candles",
            code="005930", frm=date(2024, 1, 1), too=date(2024, 1, 5),
            today_d=date(2024, 2, 1),
        )
    finally:
        await client.aclose()

    assert out["candles"] == []
    assert any(w["reason"] == "kis_transport" for w in out["data_warnings"])
