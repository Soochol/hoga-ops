import asyncio
import json

import httpx
import pytest
from fastapi import FastAPI

from hoga.live import investor_daily_flow as module
from hoga.live.investor_daily_flow import InvestorDailyFlowCache, _signed_shares
from hoga.live.kiwoom_errors import KiwoomApiError
from hoga.live.kiwoom_rest import KiwoomRestClient, Page


def row(date="20261105", value="10"):
    return {"dt": date, "orgn": value, "frgnr_invsr": "20", "natfor": "-5", "fnnc_invt": "-9999999"}


def page(rows, continuation="N", cursor=""):
    return Page(
        rows, continuation == "Y", cursor, raw={"return_code": 0, "stk_invsr_orgn": rows}, raw_cont_yn=continuation
    )


async def collect(cache, run, from_="20261101", code="005930"):
    return await cache.collect(code=code, from_=from_, to="20261106", run_page=run)


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("0", 0),
        ("-0", 0),
        ("+10", 10),
        ("-1,234", -1234),
        (" 10 ", 10),
        ("9007199254740991", 2**53 - 1),
        (0, 0),
        ("0" * 5000 + "1", 1),
    ],
)
def test_signed_shares_preserve_real_zero(raw, expected):
    assert _signed_shares(raw) == expected


@pytest.mark.parametrize(
    "raw",
    [
        None,
        "",
        "-",
        "+",
        True,
        False,
        "1+2",
        "1-2",
        "1.0",
        1.0,
        "1,00",
        "1_000",
        "1e2",
        "9007199254740992",
        "-9007199254740992",
        "9" * 5000,
        2**54,
    ],
)
def test_invalid_quantities_are_null(raw):
    assert _signed_shares(raw) is None


class Provider:
    def get_token(self):
        return "synthetic-token"


async def test_actual_http_transport_signed_direct_total_and_continuation():
    requests = []

    def handler(request):
        requests.append(request)
        return httpx.Response(
            200,
            json={
                "return_code": 0,
                "stk_invsr_orgn": [row("20261105", "-1,234")] if len(requests) == 1 else [row("20261104", "0")],
            },
            headers={"cont-yn": "Y" if len(requests) == 1 else "N", "next-key": "older"},
        )

    client = KiwoomRestClient(Provider(), transport=httpx.MockTransport(handler))
    try:

        async def run(fetch, _index):
            return await fetch(client)

        result = await collect(InvestorDailyFlowCache(), run)
        assert result.pagination == "covered" and not result.data_warnings
        assert [p.institution_net_shares for p in result.observations] == [0, -1234]
        assert all(str(r.url).endswith("/api/dostk/stkinfo") for r in requests)
        assert all(
            json.loads(r.content)
            == {"stk_cd": "005930", "dt": "20261106", "amt_qty_tp": "2", "trde_tp": "0", "unit_tp": "1"}
            for r in requests
        )
        assert requests[0].headers["cont-yn"] == "N" and requests[1].headers["next-key"] == "older"
    finally:
        await client.aclose()


@pytest.mark.parametrize("wrapper", [None, {}, "bad", 0])
async def test_bad_raw_wrapper_retries_same_cursor_and_preserves_quality(wrapper):
    cache = InvestorDailyFlowCache()
    calls = []

    async def run(fetch, index):
        calls.append(fetch.request_identity)
        if index == 0:
            return page([row(value="")], "Y", "older")
        return Page([], False, "", raw={"return_code": 0, "stk_invsr_orgn": wrapper}, raw_cont_yn="N")

    for _ in range(2):
        result = await collect(cache, run)
        assert result.pagination == "incomplete" and result.pages_observed == 1
        assert result.observations[0].institution_net_shares is None
        assert {w.reason for w in result.data_warnings} == {"invalid_row", "invalid_page"}
    assert calls[1] == calls[2] and calls[1][-1] == "older"


@pytest.mark.parametrize("headers", [{}, {"cont-yn": "bad"}, {"cont-yn": "Y"}])
async def test_real_transport_missing_or_invalid_continuation_cannot_prove_completion(headers):
    client = KiwoomRestClient(
        Provider(),
        transport=httpx.MockTransport(
            lambda _r: httpx.Response(200, json={"return_code": 0, "stk_invsr_orgn": [row()]}, headers=headers)
        ),
    )
    try:

        async def run(fetch, _index):
            return await fetch(client)

        result = await collect(InvestorDailyFlowCache(), run)
        assert result.pagination == "incomplete" and result.pages_observed == 0
        assert result.observations[0].institution_net_shares == 10
        assert result.data_warnings[-1].reason in {"invalid_page", "cursor_stalled"}
    finally:
        await client.aclose()


async def test_budget_retains_cursor_and_min_date_does_not_imply_coverage():
    cache = InvestorDailyFlowCache(page_budget=1)
    seen = []

    async def run(fetch, index):
        seen.append(fetch.request_identity[-1])
        return [page([row("20261101")], "Y", "older"), page([row("20261103", "0")])][index]

    first = await collect(cache, run)
    assert first.pagination == "incomplete" and first.can_continue
    second = await collect(cache, run)
    assert second.pagination == "covered" and not second.can_continue
    assert seen == ["", "older"]
    assert [p.date for p in second.observations] == ["20261101", "20261103"]
    await collect(cache, run)
    assert len(seen) == 2


async def test_error_retry_and_cancellation_preserve_cursor_and_completed_pages():
    cache = InvestorDailyFlowCache()
    fail = True

    async def run(_fetch, index):
        nonlocal fail
        if not index:
            return page([row()], "Y", "older")
        if fail:
            raise KiwoomApiError("synthetic", "fail")
        return page([row("20261104")])

    for _ in range(2):
        result = await collect(cache, run)
        assert result.pagination == "incomplete" and result.data_warnings[-1].reason == "api_error"

    async def cancel(_fetch, _index):
        raise asyncio.CancelledError

    with pytest.raises(asyncio.CancelledError):
        await collect(cache, cancel)
    assert cache.histories[("005930", "20261106")].users == 0
    fail = False
    result = await collect(cache, run)
    assert result.pagination == "covered" and result.data_warnings == []


async def test_repeated_cursor_and_total_budget_stay_incomplete():
    async def run(_fetch, _index):
        return page([row()], "Y", "older")

    result = await collect(InvestorDailyFlowCache(), run)
    assert result.pagination == "incomplete" and result.data_warnings[-1].reason == "cursor_stalled"
    result = await collect(InvestorDailyFlowCache(max_pages=1), run)
    assert (
        result.pagination == "incomplete"
        and not result.can_continue
        and result.data_warnings[-1].reason == "page_budget"
    )


async def test_identical_duplicates_idempotent_conflicts_survive_warm_and_ttl_accepts_correction(monkeypatch):
    clock = [0.0]
    monkeypatch.setattr(module.time, "monotonic", lambda: clock[0])
    cache = InvestorDailyFlowCache(ttl=10, historical_ttl=10)
    corrected = False

    async def run(_fetch, _index):
        return page([row(value="2")] if corrected else [row(value="0"), row(value="0"), row(value="1"), row(value="0")])

    first = await collect(cache, run)
    assert first.observations[0].institution_net_shares is None
    for now in [3, 6, 9]:
        clock[0] = now
        assert (await collect(cache, run)).model_dump() == first.model_dump()
    corrected = True
    clock[0] = 11
    fresh = await collect(cache, run)
    assert fresh.observations[0].institution_net_shares == 2 and fresh.data_warnings == []


async def test_active_ttl_capacity_and_deep_progress_preserve_generation(monkeypatch):
    clock = [0.0]
    monkeypatch.setattr(module.time, "monotonic", lambda: clock[0])
    cache = InvestorDailyFlowCache(ttl=10, historical_ttl=10, page_budget=1, max_histories=1)
    entered, release = asyncio.Event(), asyncio.Event()
    calls = []

    async def run(fetch, index):
        calls.append(fetch.request_identity)
        entered.set()
        await release.wait()
        return page([row()], "Y" if index < 2 else "N", str(index + 1))

    task = asyncio.create_task(collect(cache, run))
    await entered.wait()
    history = cache.histories[("005930", "20261106")]
    clock[0] = 20
    crowded = await collect(cache, run, code="000660")
    assert crowded.data_warnings[0].reason == "unavailable"
    other = asyncio.create_task(collect(cache, run))
    await asyncio.sleep(0)
    assert cache.histories[("005930", "20261106")] is history
    release.set()
    await asyncio.gather(task, other)
    clock[0] = 29
    done = await collect(cache, run)
    assert done.pagination == "covered" and [call[-1] for call in calls] == ["", "1", "2"]
    assert cache.histories[("005930", "20261106")] is history


@pytest.mark.parametrize("date", ["20260230", "20261301", "20301101", "", "2026115", None])
async def test_bad_dates_are_unlocated_and_persist(date):
    async def run(_fetch, _index):
        return page([row(date), row()])

    cache = InvestorDailyFlowCache()
    first = await collect(cache, run)
    assert first.unlocated_defect and len(first.observations) == 1
    assert (await collect(cache, run)).unlocated_defect


async def test_http_serialization_and_real_scheduler_identity(tmp_path, monkeypatch):
    submissions = []

    class Client:
        async def call(self, _api, _body, **kwargs):
            return page([row(value=""), row("20261104", "0")], "Y" if not kwargs["next_key"] else "N", "older")

    async def run(_scheduler, **kwargs):
        submissions.append(kwargs["key"])
        return await kwargs["fetch_fn"](kwargs["client"])

    monkeypatch.setattr(module.live_settings, "rest_bypass_enabled", lambda _dir: False)
    monkeypatch.setattr(module.kiwoom_rest_runtime, "ensure_rest_client", lambda _dir: Client())
    monkeypatch.setattr(module.kiwoom_rest_runtime, "ensure_scheduler", lambda _dir: object())
    monkeypatch.setattr(module.kiwoom_access, "run_with_capacity", run)
    app = FastAPI()
    app.include_router(module.build_router(data_dir=tmp_path))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        response = await client.get("/api/live/investor-daily-flow?code=00088K&from=20261101&to=20261106")
        wire = response.json()
        assert response.status_code == 200 and wire["from"] == "20261101" and "from_" not in wire
        assert (
            wire["observations"][0]["institution_net_shares"] == 0
            and wire["observations"][1]["institution_net_shares"] is None
        )
        assert wire["pagination"] == "covered" and wire["source"] == "kiwoom_ka10059"
        assert wire["data_warnings"][0]["date"] == "20261105"
        assert submissions[0] != submissions[1] and submissions[0][1][-1] == "" and submissions[1][1][-1] == "older"
        assert submissions[0][1][1] == tuple(
            sorted({"stk_cd": "00088K", "dt": "20261106", "amt_qty_tp": "2", "trde_tp": "0", "unit_tp": "1"}.items())
        )
        bad = await client.get("/api/live/investor-daily-flow?code=005930&from=20260230&to=20261106")
        assert bad.status_code == 422
        monkeypatch.setattr(module.live_settings, "rest_bypass_enabled", lambda _dir: True)
        bypass = await client.get("/api/live/investor-daily-flow?code=005930&from=20261101&to=20261106")
        assert bypass.json()["data_warnings"][0]["reason"] == "unavailable"


@pytest.mark.parametrize(
    "foreign,other,expected",
    [
        ("10", "-3", 7),
        ("0", "0", 0),
        ("-10", "-3", -13),
        (None, "5", None),
        ("5", None, None),
        ("9007199254740991", "1", None),
    ],
)
async def test_foreign_requires_both_components_and_safe_sum_independent_from_institution(foreign, other, expected):
    async def run(_fetch, _index):
        return page([{**row(value="123"), "frgnr_invsr": foreign, "natfor": other}])

    result = await collect(InvestorDailyFlowCache(), run)
    assert result.observations[0].institution_net_shares == 123
    assert result.observations[0].foreign_net_shares == expected
    assert all(issue.subject == "foreign" for issue in result.data_warnings)


async def test_each_subject_conflict_and_anchor_quality_is_independent():
    async def run(_fetch, _index):
        return page([row(value="1"), {**row(value="1"), "natfor": "-4"}, row("20261104", "0")])

    result = await collect(InvestorDailyFlowCache(), run)
    assert result.observations[1].institution_net_shares == 1
    assert result.observations[1].foreign_net_shares is None
    assert [(issue.reason, issue.subject) for issue in result.data_warnings] == [("duplicate_conflict", "foreign")]


@pytest.mark.parametrize("payload", [[], None, "bad wrapper"])
async def test_nonobject_http_json_is_a_partial_source_failure(payload):
    client = KiwoomRestClient(
        Provider(), transport=httpx.MockTransport(lambda _request: httpx.Response(200, json=payload))
    )
    try:

        async def run(fetch, _index):
            return await fetch(client)

        result = await collect(InvestorDailyFlowCache(), run)
        assert result.pagination == "incomplete"
        assert result.data_warnings[-1].reason == "api_error"
    finally:
        await client.aclose()
