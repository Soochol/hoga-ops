"""기관·외국인 순위의 금액, 거래소 미지원, 배치 시세 및 REST 용량 경계."""
from __future__ import annotations

import asyncio
import json
from datetime import datetime, timedelta

import httpx
import pytest

from hoga.live import kiwoom_rankings, kiwoom_rest_runtime
from hoga.live.kiwoom_rankings import KiwoomRankingsError, KiwoomRankingsFetcher, parse_rankings
from hoga.live.kiwoom_rest import KiwoomRestClient
from hoga.util.timeenc import KST


class TokenProvider:
    def get_token(self):
        return "fake-token"


class Scheduler:
    def __init__(self):
        self.submissions = []

    async def submit(self, **kwargs):
        self.submissions.append(kwargs)
        return await kwargs["call"](None)


def investor_row(code="402340", amount="+64260"):
    return {"stk_cd": code, "stk_nm": "SK스퀘어", "sel_qty": "-65331", "buy_qty": "+129591", "netslmt": amount}


def response(rows, *, cont="N", key=""):
    return httpx.Response(200, json={"return_code": 0, "opmr_invsr_trde_upper": rows},
                          headers={"cont-yn": cont, "next-key": key})


def quote_response(request):
    codes = json.loads(request.content)["stk_cd"].split("|")
    return httpx.Response(200, json={"return_code": 0, "atn_stk_infr": [
        {"stk_cd": code, "cur_prc": "-320000", "flu_rt": "-4.76"} for code in codes
    ]})


@pytest.fixture
def make_fetcher(monkeypatch, tmp_path):
    resources = []
    monkeypatch.setattr(kiwoom_rankings, "is_trading_day", lambda _day: True)

    def make(handler, *, now=None):
        client = KiwoomRestClient(TokenProvider(), transport=httpx.MockTransport(handler))
        scheduler = Scheduler()
        monkeypatch.setattr(kiwoom_rest_runtime, "ensure_rest_client", lambda _dir: client)
        monkeypatch.setattr(kiwoom_rest_runtime, "ensure_scheduler", lambda _dir: scheduler)
        fetcher = KiwoomRankingsFetcher(
            TokenProvider(), data_dir=tmp_path,
            _transport=httpx.MockTransport(lambda _r: pytest.fail("used legacy transport")),
            _now=now or (lambda: datetime(2026, 10, 8, 10, tzinfo=KST)),
        )
        resources.append((fetcher, client))
        return fetcher, scheduler

    yield make
    for fetcher, client in resources:
        fetcher.close()
        asyncio.run(client.aclose())


@pytest.mark.parametrize("kind", ["institution", "foreign"])
@pytest.mark.parametrize("amount,expected", [
    ("+64,260", 64_260_000_000), ("-1.25", -1_250_000), ("0", 0),
    ("", None), ("NaN", None), ("Infinity", None),
])
def test_parser_preserves_signed_million_won_and_does_not_recompute(kind, amount, expected):
    row = parse_rankings(kind, {"opmr_invsr_trde_upper": [investor_row("402340_AL", amount)]})[0]
    assert row.investor_net_buy_won == expected
    assert row.program_net_buy_won is row.trade_value_won is None
    assert row.price is row.change_pct is None
    assert row.code == "402340"


@pytest.mark.parametrize("kind,orgn", [("institution", "9999"), ("foreign", "9000")])
@pytest.mark.parametrize("market,mrkt", [("all", "000"), ("kospi", "001"), ("kosdaq", "101")])
async def test_request_contract_top100_quote_batch_and_capacity(make_fetcher, kind, orgn, market, mrkt):
    seen = []

    def handler(request):
        seen.append(request)
        if request.headers["api-id"] == "ka10095":
            return quote_response(request)
        return response([investor_row(f"{i:06d}", str(1000 - i)) for i in reversed(range(120))])

    fetcher, scheduler = make_fetcher(handler)
    snap = await fetcher.get(kind, market, "down", "UN")
    assert snap.direction == "up"
    assert snap.venue is None  # 거래소를 선택할 수 없는 순위에 UN을 거짓으로 붙이지 않는다.
    assert snap.quote_venue == "UN"
    assert snap.market_open
    assert [row.code for row in snap.rows] == [f"{i:06d}" for i in range(100)]
    assert [row.rank for row in snap.rows] == list(range(1, 101))
    assert snap.rows[0].investor_net_buy_won == 1_000_000_000
    assert snap.rows[0].price == 320000 and snap.rows[0].change_pct == -4.76
    assert seen[0].url.path == "/api/dostk/rkinfo"
    assert json.loads(seen[0].content) == {"trde_tp": "1", "mrkt_tp": mrkt, "orgn_tp": orgn, "amt_qty_tp": "1"}
    assert seen[1].url.path == "/api/dostk/stkinfo"
    assert json.loads(seen[1].content)["stk_cd"].split("|") == [f"{i:06d}_AL" for i in range(100)]
    assert [s["api_id"] for s in scheduler.submissions] == ["ka10065", "ka10095"]
    assert all(s["priority"] == "user_visible" for s in scheduler.submissions)


async def test_cursor_pages_each_use_governor_and_stop_at100(make_fetcher):
    seen = []

    def handler(request):
        seen.append(request)
        if request.headers["api-id"] == "ka10095":
            return quote_response(request)
        offset = int(request.headers.get("next-key") or "0")
        return response([investor_row(f"{i:06d}", str(1000 - i)) for i in range(offset, offset + 20)],
                        cont="Y", key=str(offset + 20))

    fetcher, scheduler = make_fetcher(handler)
    snap = await fetcher.get("foreign", "all", "up")
    assert len(snap.rows) == 100
    assert [r.headers["next-key"] for r in seen[:5]] == ["", "20", "40", "60", "80"]
    assert [s["api_id"] for s in scheduler.submissions] == ["ka10065"] * 5 + ["ka10095"]


async def test_invalid_nonpositive_duplicates_and_missing_quotes(make_fetcher):
    def handler(request):
        if request.headers["api-id"] == "ka10095":
            return httpx.Response(200, json={"return_code": 0, "atn_stk_infr": []})
        return response([investor_row("000001", ""), investor_row("000002", "-1"),
                         investor_row("000003", "0"), investor_row("000004", "+2"),
                         investor_row("000004_AL", "+3"), investor_row("000005", "+1")])
    fetcher, _ = make_fetcher(handler)
    snap = await fetcher.get("institution", "all", "up")
    assert [r.code for r in snap.rows] == ["000004", "000005"]
    assert snap.rows[0].investor_net_buy_won == 3_000_000
    assert all(r.price is None and r.change_pct is None for r in snap.rows)


async def test_empty_leaders_skip_quote_call(make_fetcher):
    fetcher, scheduler = make_fetcher(lambda _r: response([]))
    assert (await fetcher.get("foreign", "all", "up")).rows == ()
    assert [s["api_id"] for s in scheduler.submissions] == ["ka10065"]


async def test_cache_singleflight_kind_market_quotevenue_day_and_offhours(make_fetcher, monkeypatch):
    clock = 1000.0
    now = datetime(2026, 10, 8, 10, tzinfo=KST)
    monkeypatch.setattr(kiwoom_rankings.time, "time", lambda: clock)
    seen = []

    async def handler(request):
        seen.append(request)
        await asyncio.sleep(0)
        return quote_response(request) if request.headers["api-id"] == "ka10095" else response([investor_row()])

    fetcher, _ = make_fetcher(handler, now=lambda: now)
    a, b = await asyncio.gather(*(fetcher.get("institution", "all", "up") for _ in range(2)))
    assert a is b and len(seen) == 2
    await fetcher.get("institution", "all", "down")
    clock += 29
    await fetcher.get("institution", "all", "up")
    assert len(seen) == 2
    clock += 2
    await fetcher.get("institution", "all", "up")
    assert len(seen) == 4
    await fetcher.get("foreign", "all", "up")
    await fetcher.get("institution", "kospi", "up")
    await fetcher.get("institution", "all", "up", "NXT")
    assert len(seen) == 10
    assert json.loads(seen[-1].content)["stk_cd"] == "402340_NX"
    now = now.replace(hour=18)
    clock += 61
    snap = await fetcher.get("institution", "all", "up", "NXT")
    assert not snap.market_open  # NXT 거래시간이어도 추정 순위는 장외 주기.
    clock += 59
    assert await fetcher.get("institution", "all", "up", "NXT") is snap
    assert len(seen) == 12
    now += timedelta(days=1)
    monkeypatch.setattr(kiwoom_rankings, "is_trading_day", lambda _day: False)
    snap = await fetcher.get("institution", "all", "up", "NXT")
    assert snap.rows == () and not snap.market_open and snap.venue is None
    assert len(seen) == 12


@pytest.mark.parametrize("failure", ["vendor", "wrapper", "cursor", "limit", "quote"])
async def test_failures_are_not_cached(make_fetcher, failure):
    fail = True

    def handler(request):
        if request.headers["api-id"] == "ka10095":
            if fail and failure == "quote":
                return httpx.Response(200, json={"return_code": 3})
            return quote_response(request)
        if fail:
            if failure == "vendor":
                return httpx.Response(200, json={"return_code": 3})
            if failure == "wrapper":
                return httpx.Response(200, json={"return_code": 0, "wrong_wrapper": []})
            if failure in ("cursor", "limit"):
                return response([investor_row()], cont="Y", key="" if failure == "cursor" else "next")
        return response([investor_row()])

    fetcher, _ = make_fetcher(handler)
    with pytest.raises(KiwoomRankingsError):
        await fetcher.get("foreign", "all", "up")
    fail = False
    assert len((await fetcher.get("foreign", "all", "up")).rows) == 1


@pytest.mark.parametrize("kind", ["institution", "foreign"])
def test_route_amount_venue_contract_and_etf_filter(make_fetcher, monkeypatch, tmp_path, kind):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from hoga.api import symbols
    from hoga.live import api, lifecycle

    def handler(request):
        return quote_response(request) if request.headers["api-id"] == "ka10095" else response([
            investor_row("402340", "+64260"), investor_row("036930", "+21572"),
        ])
    fetcher, _ = make_fetcher(handler)
    monkeypatch.setattr(api, "kiwoom_rankings_fetcher_instance", fetcher)
    monkeypatch.setattr(symbols, "all_etf_etn_codes", lambda: {"402340"})
    app = FastAPI()
    app.include_router(api.build_router(get_status=lifecycle.get_status, data_dir=tmp_path))
    with TestClient(app) as client:
        r = client.get("/api/live/rankings", params={"kind": kind, "venue": "UN", "exclude_etf": True})
    assert r.status_code == 200
    body = r.json()
    assert body["venue"] is None and body["quote_venue"] == "UN"
    assert body["kind"] == kind and body["direction"] == "up"
    assert body["warnings"] == []
    assert len(body["rows"]) == 1
    assert body["rows"][0]["rank"] == 1 and body["rows"][0]["code"] == "036930"
    assert body["rows"][0]["investor_net_buy_won"] == 21_572_000_000
    assert body["rows"][0]["program_net_buy_won"] is None
