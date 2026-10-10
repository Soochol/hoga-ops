"""프로그램 순위: 실제 REST seam을 페이크 전송으로 검증한다."""
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


class FakeTokenProvider:
    def get_token(self):
        return "fake-token"


class Scheduler:
    def __init__(self):
        self.submissions = []

    async def submit(self, **kwargs):
        self.submissions.append(kwargs)
        return await kwargs["call"](None)


def program_row(code, amount, *, rank=1):
    return {
        "rank": str(rank), "stk_cd": code, "stk_nm": f"종목{code}",
        "cur_prc": "-320000", "flu_rt": "-4.76", "prm_netprps_amt": amount,
        # 순매수 금액에는 벤더 반올림 차이가 있으므로 차감으로 재계산하지 않는다.
        "prm_buy_amt": "123928", "prm_sell_amt": "59429",
    }


def response(rows, *, cont="N", key=""):
    return httpx.Response(
        200, json={"return_code": 0, "prm_netprps_upper_50": rows},
        headers={"cont-yn": cont, "next-key": key},
    )


@pytest.fixture
def make_fetcher(monkeypatch, tmp_path):
    resources = []
    monkeypatch.setattr(kiwoom_rankings, "is_trading_day", lambda _day: True)

    def make(handler, *, now=None):
        client = KiwoomRestClient(FakeTokenProvider(), transport=httpx.MockTransport(handler))
        scheduler = Scheduler()
        monkeypatch.setattr(kiwoom_rest_runtime, "ensure_rest_client", lambda _dir: client)
        monkeypatch.setattr(kiwoom_rest_runtime, "ensure_scheduler", lambda _dir: scheduler)
        fetcher = KiwoomRankingsFetcher(
            FakeTokenProvider(), data_dir=tmp_path,
            _transport=httpx.MockTransport(lambda _r: pytest.fail("program used legacy transport")),
            _now=now or (lambda: datetime(2026, 10, 8, 10, tzinfo=KST)),
        )
        resources.append((fetcher, client))
        return fetcher, scheduler

    yield make
    for fetcher, client in resources:
        fetcher.close()
        asyncio.run(client.aclose())


@pytest.mark.parametrize("raw, expected", [
    ("+64,499", 64_499_000_000), ("-1.25", -1_250_000), ("0", 0),
    ("", None), (None, None), ("invalid", None), ("NaN", None), ("Infinity", None),
])
def test_program_parser_preserves_amount_and_normalizes_code(raw, expected):
    rows = parse_rankings("program", {"prm_netprps_upper_50": [program_row("028260_AL", raw)]})
    assert rows[0].program_net_buy_won == expected
    assert rows[0].trade_value_won is None
    assert rows[0].code == "028260"
    assert rows[0].price == 320000
    assert rows[0].change_pct == -4.76


async def test_program_stops_after_four_pages_and_schedules_every_page(make_fetcher):
    seen = []

    def handler(request):
        body = json.loads(request.content)
        seen.append((body, dict(request.headers)))
        offset = int(request.headers.get("next-key") or "0")
        return response([
            program_row(f"{i:06d}_NX", str(1000 - i), rank=i + 1)
            for i in range(offset, offset + 15)
        ], cont="Y", key=str(offset + 15))

    fetcher, scheduler = make_fetcher(handler)
    snapshot = await fetcher.get("program", "kosdaq", "down", "NXT")
    assert len(snapshot.rows) == 50
    assert [r.rank for r in snapshot.rows] == list(range(1, 51))
    assert snapshot.rows[-1].code == "000049"
    assert snapshot.direction == "up"
    assert snapshot.venue == "NXT"
    assert len(scheduler.submissions) == len(seen) == 4
    assert all(s["api_id"] == "ka90003" and s["priority"] == "user_visible" for s in scheduler.submissions)
    assert seen[0][0] == {"trde_upper_tp": "2", "amt_qty_tp": "1", "mrkt_tp": "P10102", "stex_tp": "2"}
    assert [s[1]["next-key"] for s in seen] == ["", "15", "30", "45"]
    assert [s[1]["cont-yn"] for s in seen] == ["N", "Y", "Y", "Y"]


async def test_all_market_merges_by_amount_removes_duplicates_and_caps_50(make_fetcher):
    seen = []

    def handler(request):
        body = json.loads(request.content)
        seen.append(body)
        kospi = body["mrkt_tp"] == "P00101"
        # 다른 시장 순위와 중복 코드가 섞여도 전역 순위·금액 기준으로 결정한다.
        rows = [program_row("000999_AL", "9999")]
        rows += [program_row(f"{i + (0 if kospi else 100):06d}_AL", str(1000 - 2 * i - (0 if kospi else 1)))
                 for i in range(49)]
        return response(rows)

    fetcher, _scheduler = make_fetcher(handler)
    snapshot = await fetcher.get("program", "all", "up", "UN")
    assert {b["mrkt_tp"] for b in seen} == {"P00101", "P10102"}
    assert all(b["stex_tp"] == "3" for b in seen)
    assert len(snapshot.rows) == len({r.code for r in snapshot.rows}) == 50
    assert [r.code for r in snapshot.rows[:5]] == ["000999", "000000", "000100", "000001", "000101"]
    assert [r.rank for r in snapshot.rows] == list(range(1, 51))
    amounts = [r.program_net_buy_won for r in snapshot.rows]
    assert amounts == sorted(amounts, reverse=True)


async def test_missing_zero_and_negative_net_amounts_are_not_net_buy_leaders(make_fetcher):
    fetcher, _ = make_fetcher(lambda _r: response([
        program_row("000001", ""), program_row("000002", "0"),
        program_row("000003", "-1"), program_row("000004", "+2"),
    ]))
    snapshot = await fetcher.get("program", "kospi", "up")
    assert [r.code for r in snapshot.rows] == ["000004"]
    assert snapshot.rows[0].rank == 1


async def test_program_cache_and_single_flight_share_calls_but_split_venue_and_day(make_fetcher):
    now = datetime(2026, 10, 8, 10, tzinfo=KST)
    calls = []

    async def handler(request):
        calls.append(json.loads(request.content))
        await asyncio.sleep(0)
        return response([program_row("000001", "2")])

    fetcher, _ = make_fetcher(handler, now=lambda: now)
    a, b = await asyncio.gather(*(fetcher.get("program", "kospi", "up") for _ in range(2)))
    assert a is b
    assert len(calls) == 1
    await fetcher.get("program", "kospi", "down")  # 등락률 방향은 프로그램 캐시를 가르지 않는다.
    assert len(calls) == 1
    await fetcher.get("program", "kospi", "up", "NXT")
    assert len(calls) == 2
    now += timedelta(days=1)
    await fetcher.get("program", "kospi", "up")
    assert len(calls) == 3


async def test_program_ttl_is_30_seconds_and_off_hours_is_60(make_fetcher, monkeypatch):
    clock = 1000.0
    now = datetime(2026, 10, 8, 10, tzinfo=KST)
    monkeypatch.setattr(kiwoom_rankings.time, "time", lambda: clock)
    calls = []
    fetcher, _ = make_fetcher(
        lambda r: (calls.append(r) or response([program_row("000001", "2")])), now=lambda: now,
    )
    await fetcher.get("program", "kospi", "up")
    clock += 29
    await fetcher.get("program", "kospi", "up")
    assert len(calls) == 1
    clock += 2
    await fetcher.get("program", "kospi", "up")
    assert len(calls) == 2
    now = now.replace(hour=22)
    clock += 61
    snapshot = await fetcher.get("program", "kospi", "up")
    assert not snapshot.market_open
    assert len(calls) == 3
    clock += 59
    await fetcher.get("program", "kospi", "up")
    assert len(calls) == 3


async def test_holiday_does_not_reuse_previous_day_or_call_vendor(make_fetcher, monkeypatch):
    now = datetime(2026, 10, 8, 10, tzinfo=KST)
    calls = []
    fetcher, _ = make_fetcher(
        lambda r: (calls.append(r) or response([program_row("000001", "2")])), now=lambda: now,
    )
    await fetcher.get("program", "kospi", "up")
    now += timedelta(days=1)
    monkeypatch.setattr(kiwoom_rankings, "is_trading_day", lambda _day: False)
    snapshot = await fetcher.get("program", "kospi", "up")
    assert snapshot.rows == ()
    assert not snapshot.market_open
    assert len(calls) == 1


@pytest.mark.parametrize("failure", ["vendor", "wrapper", "cursor", "page_limit"])
async def test_failed_program_queries_are_not_cached(make_fetcher, failure):
    fail = True

    def handler(_request):
        if fail:
            if failure == "vendor":
                return httpx.Response(200, json={"return_code": 3, "return_msg": "failed"})
            if failure == "wrapper":
                return httpx.Response(200, json={"return_code": 0, "wrong_wrapper": []})
            return response([program_row("000001", "2")], cont="Y", key="" if failure == "cursor" else "next")
        return response([program_row("000001", "2")])

    fetcher, _ = make_fetcher(handler)
    with pytest.raises(KiwoomRankingsError):
        await fetcher.get("program", "kospi", "up")
    fail = False
    assert len((await fetcher.get("program", "kospi", "up")).rows) == 1


def test_program_route_preserves_money_and_filters_normalized_etf_codes(make_fetcher, monkeypatch, tmp_path):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from hoga.api import symbols
    from hoga.live import api, lifecycle

    fetcher, _ = make_fetcher(lambda _r: response([
        program_row("028260_AL", "+64499"), program_row("000660_AL", "+63479"),
    ]))
    monkeypatch.setattr(api, "kiwoom_rankings_fetcher_instance", fetcher)
    monkeypatch.setattr(symbols, "all_etf_etn_codes", lambda: {"028260"})
    app = FastAPI()
    app.include_router(api.build_router(get_status=lifecycle.get_status, data_dir=tmp_path))
    with TestClient(app) as client:
        r = client.get("/api/live/rankings", params={
            "kind": "program", "market": "kospi", "venue": "UN", "exclude_etf": True,
        })
    assert r.status_code == 200
    body = r.json()
    assert body["kind"] == "program"
    assert body["venue"] == "UN"
    assert body["warnings"] == []
    assert len(body["rows"]) == 1
    assert body["rows"][0]["rank"] == 1
    assert body["rows"][0]["code"] == "000660"
    assert body["rows"][0]["program_net_buy_won"] == 63_479_000_000
    assert body["rows"][0]["trade_value_won"] is None
