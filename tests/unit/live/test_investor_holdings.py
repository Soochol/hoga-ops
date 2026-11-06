import asyncio
import json
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI

from hoga.live import investor_holdings as holdings
from hoga.live.investor_holdings import HoldingsCache, parse_observation
from hoga.live.kiwoom_errors import KiwoomApiError, KiwoomAuthError, KiwoomRateLimitError
from hoga.live.kiwoom_rest import KiwoomRestClient, Page


class _Provider:
    def get_token(self):
        return "synthetic-token"


def row(date="20261105", qty="12345", ratio="+26.10"):
    return {"dt": date, "poss_stkcnt": qty, "wght": ratio, "limit_exh_rt": "99.99"}



def page(rows, cont=False, next_key=""):
    return Page(rows, cont, next_key, raw={"return_code": 0, "stk_frgnr": rows})

def test_official_guide_sample_units_and_ratio_field():
    fixture = Path(__file__).parents[2] / "fixtures/kiwoom_rest/ka10008_official_guide.json"
    sample = json.loads(fixture.read_text())["stk_frgnr"][0]
    point = parse_observation(sample)
    assert point.quantity_shares == 6663509
    assert point.ratio_pct == 26.10
    assert point.date == "20241105"
    assert parse_observation(row()).ratio_pct == 26.10


@pytest.mark.parametrize("bad", [None, "", "-1", "1.5", "NaN", "Infinity", "9007199254740993", True])
def test_invalid_quantity_is_null_without_losing_independent_ratio(bad):
    point = parse_observation(row(qty=bad))
    assert point.quantity_shares is None
    assert point.ratio_pct == 26.10


@pytest.mark.parametrize("bad", [None, "", "-1", "100.01", "NaN", "Infinity", True])
def test_invalid_ratio_is_null_without_using_limit_exhaustion(bad):
    point = parse_observation(row(ratio=bad))
    assert point.ratio_pct is None
    assert point.quantity_shares == 12345


def test_real_zero_and_bad_date():
    point = parse_observation(row(qty="0", ratio="0"))
    assert point.quantity_shares == point.ratio_pct == 0
    assert parse_observation(None) is None
    assert parse_observation("malformed") is None
    for date in ["20260230", "2026115", "", "bogus"]:
        assert parse_observation(row(date=date)) is None


async def test_real_transport_request_has_only_code_and_continuation_headers():
    requests = []

    def handler(request):
        requests.append(request)
        count = len(requests)
        return httpx.Response(200, json={"return_code": 0, "stk_frgnr": [row(f"2026110{6-count}")]},
                              headers={"cont-yn": "Y" if count == 1 else "N", "next-key": "older"})

    client = KiwoomRestClient(_Provider(), transport=httpx.MockTransport(handler))
    try:
        async def run_page(fetch, _index):
            return await fetch(client)
        result = await HoldingsCache().collect("005930", "20261101", "20261106", run_page)
        assert result.exhausted and result.pagination_complete and not result.partial
        assert [p.date for p in result.observations] == ["20261104", "20261105"]
        assert all(str(r.url).endswith("/api/dostk/frgnistt") for r in requests)
        assert all(json.loads(r.content) == {"stk_cd": "005930"} for r in requests)
        assert requests[0].headers["api-id"] == "ka10008"
        assert requests[1].headers["cont-yn"] == "Y"
        assert requests[1].headers["next-key"] == "older"
    finally:
        await client.aclose()


@pytest.mark.parametrize("error", [KiwoomApiError("x", "fail"), KiwoomAuthError("fail"), KiwoomRateLimitError("fail")])
async def test_partial_retry_preserves_pages_and_deep_pan_continues_cursor(error):
    cache = HoldingsCache(page_budget=1)
    requests = []
    failure = True

    class Client:
        async def call(self, _api, body, **kwargs):
            nonlocal failure
            requests.append((body, kwargs))
            if kwargs["next_key"] == "older" and failure:
                failure = False
                raise error
            return page([row("20261105" if not kwargs["next_key"] else "20261101")],
                        not kwargs["next_key"], "older")

    async def run_page(fetch, _index):
        return await fetch(Client())

    first = await cache.collect("005930", "20261101", "20261106", run_page)
    assert first.partial and first.pages_observed == 1
    failed = await cache.collect("005930", "20261101", "20261106", run_page)
    assert failed.partial and len(failed.observations) == 1
    assert failed.data_warnings[-1].reason == "api_error"
    retry = await cache.collect("005930", "20261101", "20261106", run_page)
    assert not retry.partial and retry.pages_observed == 2
    assert [p.date for p in retry.observations] == ["20261101", "20261105"]
    assert requests[1][1]["next_key"] == requests[2][1]["next_key"] == "older"
    calls = len(requests)
    narrow = await cache.collect("005930", "20261105", "20261105", run_page)
    assert len(requests) == calls and len(narrow.observations) == 1


async def test_cursor_stall_and_invalid_date_do_not_claim_unvisited_history():
    cache = HoldingsCache()
    async def run_page(_fetch, _index):
        return page([row("not-date"), row()], True, "")
    result = await cache.collect("005930", "20260101", "20261106", run_page)
    assert result.partial and not result.exhausted and not result.pagination_complete
    assert {w.reason for w in result.data_warnings} == {"invalid_row", "cursor_stalled"}
    assert len(result.observations) == 1


async def test_expiry_never_replaces_an_active_code_owner(monkeypatch):
    cache = HoldingsCache(ttl=0)
    entered, release = asyncio.Event(), asyncio.Event()
    calls = 0
    async def run_page(_fetch, _index):
        nonlocal calls
        calls += 1
        entered.set()
        await release.wait()
        return page([row()], False, "")
    task = asyncio.create_task(cache.collect("005930", "20261101", "20261106", run_page))
    await entered.wait()
    owner = cache.histories["005930"]
    other = asyncio.create_task(cache.collect("005930", "20261101", "20261106", run_page))
    await asyncio.sleep(0)
    assert cache.histories["005930"] is owner
    release.set()
    await asyncio.gather(task, other)
    assert calls == 1
    await cache.collect("005930", "20261101", "20261106", run_page)
    assert calls == 2


async def test_http_no_credentials_bypass_and_wire_nulls(tmp_path, monkeypatch):
    app = FastAPI()
    app.include_router(holdings.build_router(data_dir=tmp_path))
    monkeypatch.setattr(holdings.kiwoom_rest_runtime, "ensure_rest_client", lambda _dir: None)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        response = await client.get("/api/live/investor-holdings?code=005930&from=20261101&to=20261106")
        assert response.status_code == 200
        wire = response.json()
        assert wire["from"] == "20261101" and "from_" not in wire
        assert wire["source"] == "kiwoom_ka10008" and wire["institution_supported"] is False
        assert wire["partial"] and wire["observations"] == []
        assert wire["latest_observed_date"] is None
        assert wire["data_warnings"][0]["reason"] == "unavailable"
        bad = await client.get("/api/live/investor-holdings?code=005930&from=20260230&to=20261106")
        assert bad.status_code == 422
        monkeypatch.setattr(holdings.live_settings, "rest_bypass_enabled", lambda _dir: True)
        def forbidden(_dir):
            pytest.fail("bypass must not initialize vendor")
        monkeypatch.setattr(holdings.kiwoom_rest_runtime, "ensure_rest_client", forbidden)
        response = await client.get("/api/live/investor-holdings?code=005930&from=20261101&to=20261106")
        assert response.status_code == 200


async def test_http_populated_wire_preserves_nulls_and_submits_each_page(tmp_path, monkeypatch):
    calls = []
    class Client:
        async def call(self, api_id, body, **kwargs):
            calls.append((api_id, body, kwargs))
            return page([row(qty="-1"), row(date="20261104", qty="0", ratio="0")], False, "")
    client = Client()
    monkeypatch.setattr(holdings.live_settings, "rest_bypass_enabled", lambda _dir: False)
    monkeypatch.setattr(holdings.kiwoom_rest_runtime, "ensure_rest_client", lambda _dir: client)
    monkeypatch.setattr(holdings.kiwoom_rest_runtime, "ensure_scheduler", lambda _dir: object())
    submissions = []
    async def run(_scheduler, **kwargs):
        submissions.append((kwargs["api_id"], kwargs["priority"]))
        return await kwargs["fetch_fn"](kwargs["client"])
    monkeypatch.setattr(holdings.kiwoom_access, "run_with_capacity", run)
    app = FastAPI()
    app.include_router(holdings.build_router(data_dir=tmp_path))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as http:
        response = await http.get("/api/live/investor-holdings?code=00088K&from=20261101&to=20261106")
        assert response.status_code == 200
        wire = response.json()
        assert wire["observations"][0]["quantity_shares"] == 0
        assert wire["observations"][1]["quantity_shares"] is None
        assert wire["observations"][1]["ratio_pct"] == 26.1
        assert wire["data_warnings"][0]["reason"] == "invalid_row"
        assert not wire["partial"] and wire["exhausted"]
        assert submissions == [("ka10008", "user_visible")]
        assert calls[0][1] == {"stk_cd": "00088K"}


@pytest.mark.parametrize("bad", ["1,2", ",,0,,", "1,00", "1,234,56", "1_000", "1e2", "1E+1", "+NaN", "inf", "1.", ".5"])
def test_malformed_numeric_lexemes_never_fabricate_balance_or_zero(bad):
    point = parse_observation(row(qty=bad, ratio=bad))
    assert point.quantity_shares is None
    assert point.ratio_pct is None


@pytest.mark.parametrize("qty,ratio,expected_qty,expected_ratio", [
    ("+6,663,509", "+26.10", 6663509, 26.1),
    ("0", "0.00", 0, 0),
    (" 12345 ", "100.00", 12345, 100),
    ("9007199254740991", "0.01", 9007199254740991, .01),
])
def test_signed_decimal_and_properly_grouped_thousands(qty, ratio, expected_qty, expected_ratio):
    point = parse_observation(row(qty=qty, ratio=ratio))
    assert point.quantity_shares == expected_qty
    assert point.ratio_pct == expected_ratio


async def test_unordered_pages_continue_even_after_requested_start_was_observed():
    cache = HoldingsCache(page_budget=1)
    calls = []
    async def run_page(_fetch, index):
        calls.append(index)
        return [page([row("20261101"), row("20261105")], True, "next"),
                page([row("20261103")])][index]
    first = await cache.collect("005930", "20261101", "20261106", run_page)
    assert first.partial and not first.pagination_complete and not first.exhausted
    assert first.data_warnings[-1].reason == "page_budget"
    second = await cache.collect("005930", "20261101", "20261106", run_page)
    assert calls == [0, 1]
    assert [p.date for p in second.observations] == ["20261101", "20261103", "20261105"]
    assert second.pagination_complete and second.exhausted and not second.partial


@pytest.mark.parametrize("envelope", [{"return_code": 0}, *[
    {"return_code": 0, "stk_frgnr": value} for value in [None, {}, "rows"]
]])
async def test_malformed_real_transport_wrapper_preserves_previous_page_and_retries(envelope):
    requests = []
    def handler(request):
        requests.append(request)
        body = {"return_code": 0, "stk_frgnr": [row()]} if len(requests) == 1 else envelope
        return httpx.Response(200, json=body,
                              headers={"cont-yn": "Y" if len(requests) == 1 else "N", "next-key": "older"})
    client = KiwoomRestClient(_Provider(), transport=httpx.MockTransport(handler))
    try:
        async def run_page(fetch, _index):
            return await fetch(client)
        cache = HoldingsCache()
        for _ in range(2):
            result = await cache.collect("005930", "20261101", "20261106", run_page)
            assert result.partial and not result.exhausted and not result.pagination_complete
            assert result.pages_observed == 1
            assert [p.date for p in result.observations] == ["20261105"]
            assert result.data_warnings[-1].reason == "api_error"
        assert len(requests) == 3
        assert requests[1].headers["next-key"] == requests[2].headers["next-key"] == "older"
    finally:
        await client.aclose()


async def test_real_empty_list_is_valid_exhaustion():
    client = KiwoomRestClient(_Provider(), transport=httpx.MockTransport(
        lambda _request: httpx.Response(200, json={"return_code": 0, "stk_frgnr": []})))
    try:
        async def run_page(fetch, _index):
            return await fetch(client)
        result = await HoldingsCache().collect("005930", "20261101", "20261106", run_page)
        assert result.pagination_complete and result.exhausted and not result.partial
        assert result.pages_observed == 1 and result.observations == [] and result.data_warnings == []
    finally:
        await client.aclose()


async def test_capacity_overload_preserves_pages_and_cancellation_still_propagates():
    from hoga.live.kiwoom_capacity import KiwoomCapacityOverloaded
    cache = HoldingsCache()
    async def run_page(_fetch, index):
        if index:
            raise KiwoomCapacityOverloaded("synthetic overload")
        return page([row()], True, "older")
    result = await cache.collect("005930", "20261101", "20261106", run_page)
    assert result.partial and result.pages_observed == 1
    assert [p.date for p in result.observations] == ["20261105"]
    assert result.data_warnings[-1].reason == "api_error"
    async def cancelled(_fetch, _index):
        raise asyncio.CancelledError
    with pytest.raises(asyncio.CancelledError):
        await cache.collect("005930", "20261101", "20261106", cancelled)
    assert cache.histories["005930"].users == 0


async def test_identical_duplicates_are_harmless_but_conflicts_invalidate_whole_date_permanently():
    async def identical(_fetch, index):
        return page([row(qty="0", ratio="0")], index == 0, "older")
    clean = await HoldingsCache().collect("005930", "20261101", "20261106", identical)
    assert clean.data_warnings == []
    assert clean.observations[0].quantity_shares == clean.observations[0].ratio_pct == 0
    async def conflicting(_fetch, index):
        rows = [[row(qty="100", ratio="20")], [row(qty="200", ratio="30")],
                [row(qty="0", ratio="0"), row("20261104", qty="300", ratio="40")]][index]
        return page(rows, index < 2, str(index + 1))
    result = await HoldingsCache().collect("005930", "20261101", "20261106", conflicting)
    assert result.exhausted and result.pagination_complete
    assert result.observations[0].quantity_shares == 300
    assert result.observations[1].quantity_shares is None and result.observations[1].ratio_pct is None
    assert [(w.reason, "서로 달라" in w.message) for w in result.data_warnings] == [("invalid_row", True)]


async def test_future_provider_dates_do_not_expand_observed_metadata(monkeypatch):
    from datetime import datetime
    class FixedDate(datetime):
        @classmethod
        def now(cls, tz=None):
            return cls(2026, 11, 6, tzinfo=tz)
    monkeypatch.setattr(holdings, "datetime", FixedDate)
    async def run_page(_fetch, _index):
        return page([row("20261105"), row("20261107")])
    result = await HoldingsCache().collect("005930", "20261101", "20261108", run_page)
    assert [p.date for p in result.observations] == ["20261105"]
    assert result.oldest_observed_date == result.latest_observed_date == "20261105"
    assert result.data_warnings[0].reason == "invalid_row"
