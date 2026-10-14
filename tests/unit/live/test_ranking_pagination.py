"""순위 확장: 페이지 크기 차이, 갱신 범위, 실패 원자성, ETF 후처리."""
from __future__ import annotations

import asyncio
import json
from datetime import datetime

import httpx
import pytest

from hoga.live import kiwoom_rankings, kiwoom_rest_runtime
from hoga.live.kiwoom_rankings import _KIND_SPEC, KiwoomRankingsError, KiwoomRankingsFetcher
from hoga.util.timeenc import KST


class Token:
    def get_token(self):
        return "fake-token"


class Scheduler:
    def __init__(self):
        self.calls = []

    async def submit(self, **kwargs):
        self.calls.append(kwargs)
        return await kwargs["call"](None)


def response(kind, start, count, *, cont="N", key=""):
    return httpx.Response(200, headers={"cont-yn": cont, "next-key": key}, json={
        "return_code": 0,
        _KIND_SPEC[kind].wrapper_key: [
            {"stk_cd": f"{i:06d}", "stk_nm": f"종목{i}", "cur_prc": "+1000", "flu_rt": "+1"}
            for i in range(start, start + count)
        ],
    })


@pytest.fixture
def make_fetcher(monkeypatch):
    resources = []
    monkeypatch.setattr(kiwoom_rankings, "is_trading_day", lambda _day: True)
    scheduler = Scheduler()
    monkeypatch.setattr(kiwoom_rest_runtime, "ensure_scheduler", lambda _dir: scheduler)

    def make(handler):
        fetcher = KiwoomRankingsFetcher(
            Token(), _transport=httpx.MockTransport(handler),
            _now=lambda: datetime(2026, 10, 14, 10, tzinfo=KST),
        )
        resources.append(fetcher)
        return fetcher, scheduler

    yield make
    for fetcher in resources:
        fetcher.close()


@pytest.mark.parametrize("kind,page_size", [("value", 100), ("volume", 100), ("change", 200), ("surge", 200)])
async def test_each_page_is_scheduled_and_expansion_starts_fresh(make_fetcher, kind, page_size):
    requests = []

    def handler(request):
        requests.append(request)
        start = int(request.headers["next-key"] or "0")
        return response(kind, start, page_size, cont="Y", key=str(start + page_size))

    fetcher, scheduler = make_fetcher(handler)
    first = await fetcher.get(kind, "all", "up")
    assert len(first.rows) == first.queried_count == 100
    assert first.has_more
    expanded = await fetcher.get(kind, "all", "up", limit=200)
    assert len(expanded.rows) == expanded.queried_count == 200
    assert [r.rank for r in expanded.rows] == list(range(1, 201))
    assert len(requests) == len(scheduler.calls) == (3 if page_size == 100 else 2)
    assert requests[1].headers["cont-yn"] == "N"  # 새 조회 범위도 첫 페이지부터
    assert all(c["api_id"] == _KIND_SPEC[kind].api_id and c["priority"] == "user_visible" for c in scheduler.calls)
    assert all(json.loads(r.content)["mrkt_tp"] == "000" for r in requests)


async def test_remainder_in_final_200_row_page_is_still_expandable(make_fetcher):
    fetcher, scheduler = make_fetcher(lambda _r: response("change", 0, 150))
    first = await fetcher.get("change", "all", "up")
    assert first.queried_count == 100 and first.has_more
    last = await fetcher.get("change", "all", "up", limit=200)
    assert len(last.rows) == last.queried_count == 150 and not last.has_more
    assert len(scheduler.calls) == 2


async def test_final_partial_page_and_duplicate_codes(make_fetcher):
    def handler(request):
        if not request.headers["next-key"]:
            return response("value", 0, 100, cont="Y", key="next")
        return response("value", 99, 51)  # 페이지 사이 순위 이동으로 한 코드 겹침

    fetcher, _ = make_fetcher(handler)
    snap = await fetcher.get("value", "all", "up", limit=200)
    assert snap.queried_count == 151 and not snap.has_more
    assert len(snap.rows) == len({r.code for r in snap.rows}) == 150


async def test_failed_expansion_keeps_small_cache_and_retry_restarts_first_page(make_fetcher):
    fail = True
    cursors = []

    def handler(request):
        cursor = request.headers["next-key"]
        cursors.append(cursor)
        if cursor and fail:
            return httpx.Response(200, json={"return_code": 3, "return_msg": "failure"})
        start = int(cursor or "0")
        return response("value", start, 100, cont="Y", key=str(start + 100))

    fetcher, _ = make_fetcher(handler)
    first = await fetcher.get("value", "all", "up")
    with pytest.raises(KiwoomRankingsError):
        await fetcher.get("value", "all", "up", limit=200)
    assert await fetcher.get("value", "all", "up") is first
    fail = False
    assert len((await fetcher.get("value", "all", "up", limit=200)).rows) == 200
    assert cursors == ["", "", "100", "", "100"]


async def test_expanded_polling_refreshes_entire_range_and_single_flight(make_fetcher, monkeypatch):
    clock = 1000.0
    monkeypatch.setattr(kiwoom_rankings.time, "time", lambda: clock)
    requests = []

    async def handler(request):
        requests.append(request.headers["next-key"])
        await asyncio.sleep(0)
        start = int(request.headers["next-key"] or "0")
        return response("value", start, 100, cont="Y", key=str(start + 100))

    fetcher, _ = make_fetcher(handler)
    a, b = await asyncio.gather(*(fetcher.get("value", "all", "up", limit=200) for _ in range(2)))
    assert a is b and requests == ["", "100"]
    clock += 9
    updated = await fetcher.get("value", "all", "up", limit=200)
    assert len(updated.rows) == 200 and requests == ["", "100", "", "100"]


@pytest.mark.parametrize("bad_key", ["", "same"])
async def test_missing_or_repeated_cursor_rejects_incomplete_result(make_fetcher, bad_key):
    fetcher, _ = make_fetcher(lambda _r: response("value", 0, 100, cont="Y", key=bad_key))
    with pytest.raises(KiwoomRankingsError, match="연속 조회 키"):
        await fetcher.get("value", "all", "up", limit=300)


async def test_empty_response_ends_list(make_fetcher):
    fetcher, _ = make_fetcher(lambda _r: response("value", 0, 0))
    snap = await fetcher.get("value", "all", "up")
    assert snap.rows == () and snap.queried_count == 0 and not snap.has_more


async def test_page_safety_limit_is_an_error_not_a_false_end(make_fetcher, monkeypatch):
    monkeypatch.setattr(kiwoom_rankings, "_RANKING_MAX_PAGES", 2)

    def handler(request):
        start = int(request.headers["next-key"] or "0")
        return response("value", start, 1, cont="Y", key=str(start + 1))

    fetcher, _ = make_fetcher(handler)
    with pytest.raises(KiwoomRankingsError, match="한도"):
        await fetcher.get("value", "all", "up", limit=100)
    assert not fetcher._cache


async def test_malformed_wrapper_is_not_accepted_as_an_empty_ranking(make_fetcher):
    fetcher, _ = make_fetcher(lambda _r: httpx.Response(200, json={"return_code": 0}))
    with pytest.raises(KiwoomRankingsError, match="응답 형식"):
        await fetcher.get("value", "all", "up")


def test_route_preserves_range_before_etf_filter_and_validates_limit(make_fetcher, monkeypatch, tmp_path):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from hoga.api import symbols
    from hoga.live import api, lifecycle

    fetcher, _ = make_fetcher(lambda _r: response("value", 0, 100, cont="Y", key="next"))
    monkeypatch.setattr(api, "kiwoom_rankings_fetcher_instance", fetcher)
    monkeypatch.setattr(symbols, "all_etf_etn_codes", lambda: {"000000"})
    app = FastAPI()
    app.include_router(api.build_router(get_status=lifecycle.get_status, data_dir=tmp_path))
    client = TestClient(app)
    body = client.get("/api/live/rankings", params={"kind": "value", "exclude_etf": True}).json()
    assert len(body["rows"]) == 99 and body["queried_count"] == 100 and body["has_more"]
    assert body["rows"][0]["rank"] == 1
    for limit in (0, 5001):
        assert client.get("/api/live/rankings", params={"kind": "value", "limit": limit}).status_code == 422
