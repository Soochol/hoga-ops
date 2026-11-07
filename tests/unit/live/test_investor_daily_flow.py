import asyncio
import json

import httpx
import pytest

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
    return (await cache.collect(code=code, from_=from_, to="20261106", run_page=run)).daily_flow


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

        cache = InvestorDailyFlowCache()
        first = await collect(cache, run)
        assert first.pages_observed == 1 and first.pagination == "incomplete" and len(requests) == 1
        result = await collect(cache, run)
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

    await collect(cache, run)
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


@pytest.mark.parametrize("value", ["10", "", None])
async def test_accepted_first_page_boundary_stops_warm_range_without_inventing_coverage(value):
    cache = InvestorDailyFlowCache()
    calls = []

    async def run(fetch, _index):
        calls.append(fetch.request_identity[-1])
        return page([row(), row("20261031", value)], "Y", "older")

    first = await collect(cache, run)
    assert first.pagination == "incomplete" and not first.can_continue
    assert first.pages_observed == 1 and [p.date for p in first.observations] == ["20261105"]
    assert all(issue.reason == "invalid_row" and issue.date == "20261031" for issue in first.data_warnings)
    assert bool(first.data_warnings) == (value != "10")
    assert (await collect(cache, run)).model_dump() == first.model_dump()
    assert calls == [""]
    assert cache.histories[("005930", "20261106")].oldest_accepted_date == "20261031"


async def test_next_page_boundary_stops_batch_but_equality_keeps_loading():
    cache = InvestorDailyFlowCache()
    calls = []

    async def run(fetch, index):
        calls.append(fetch.request_identity[-1])
        return page([row(["20261105", "20261101", "20261031"][index])], "Y", str(index + 1))

    await collect(cache, run)
    result = await collect(cache, run)
    assert calls == ["", "1", "2"]
    assert result.pages_observed == 3 and result.pagination == "incomplete" and not result.can_continue
    assert [point.date for point in result.observations] == ["20261101", "20261105"]
    assert result.data_warnings == []
    await collect(cache, run)
    assert calls == ["", "1", "2"]


@pytest.mark.parametrize("continuation,cursor", [(None, "older2"), ("Y", "older")])
async def test_failed_continuation_older_row_preserves_quality_but_cannot_stop_retry(continuation, cursor):
    cache = InvestorDailyFlowCache(page_budget=1)
    calls = []

    async def run(fetch, index):
        calls.append(fetch.request_identity[-1])
        if index == 0:
            return page([row()], "Y", "older")
        if len(calls) == 2:
            return page([row("20261031", "")], continuation, cursor)
        return page([row("20261031", "")], "Y", "older2")

    await collect(cache, run)
    failed = await collect(cache, run)
    assert failed.can_continue and failed.pages_observed == 1
    assert cache.histories[("005930", "20261106")].oldest_accepted_date == "20261105"
    assert {issue.reason for issue in failed.data_warnings} == {
        "invalid_row", "invalid_page" if continuation is None else "cursor_stalled",
    }
    retried = await collect(cache, run)
    assert calls == ["", "older", "older"]
    assert retried.pages_observed == 2 and not retried.can_continue and retried.pagination == "incomplete"
    assert [issue.reason for issue in retried.data_warnings] == ["invalid_row"]


async def test_wider_range_resumes_cursor_and_can_reveal_earlier_source_row_and_loaded_conflict():
    cache = InvestorDailyFlowCache()
    calls = []

    async def run(fetch, index):
        calls.append(fetch.request_identity[-1])
        if index == 0:
            return page([row("20261105", "1"), row("20261031", "0")], "Y", "older")
        return page([row("20261030", "4"), row("20261105", "2")])

    narrow = await collect(cache, run)
    assert not narrow.can_continue and narrow.pagination == "incomplete"
    assert narrow.observations[0].institution_net_shares == 1
    wider = await collect(cache, run, from_="20261001")
    assert calls == ["", "older"] and wider.pagination == "covered"
    assert [point.date for point in wider.observations] == ["20261030", "20261031", "20261105"]
    assert wider.observations[-1].institution_net_shares is None
    assert wider.observations[-1].foreign_net_shares == 15
    assert [(issue.reason, issue.date, issue.subject) for issue in wider.data_warnings] == [
        ("duplicate_conflict", "20261105", "institution"),
    ]


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

    await collect(cache, run)
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

    cache = InvestorDailyFlowCache()
    await collect(cache, run)
    result = await collect(cache, run)
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


async def test_today_boundary_refresh_ages_from_first_accepted_page_not_deeper_progress(monkeypatch):
    clock = [0.0]
    monkeypatch.setattr(module.time, "monotonic", lambda: clock[0])
    today = module.datetime.now(module.KST).strftime("%Y%m%d")
    cache = InvestorDailyFlowCache()
    calls = []

    async def run(fetch, index):
        calls.append(fetch.request_identity[-1])
        return page([row("20261031" if index else "20261105", str(len(calls)))], "Y", str(len(calls)))

    async def today_collect():
        return await cache.collect(code="005930", from_="20261101", to=today, run_page=run)

    await today_collect()
    history = cache.histories[("005930", today)]
    clock[0] = 50
    boundary = await today_collect()
    assert not boundary.daily_flow.can_continue and boundary.daily_flow.pagination == "incomplete"
    assert history.fresh == 0 and history.progressed == 50
    clock[0] = 61
    refreshed = await today_collect()
    assert calls == ["", "1", ""]
    assert cache.histories[("005930", today)] is not history
    assert refreshed.daily_flow.observations[0].institution_net_shares == 3
    assert refreshed.daily_flow.pages_observed == 1 and refreshed.daily_flow.can_continue


async def test_slow_multi_request_continuation_survives_aged_head_until_boundary(monkeypatch):
    clock = [0.0]
    monkeypatch.setattr(module.time, "monotonic", lambda: clock[0])
    today = module.datetime.now(module.KST).strftime("%Y%m%d")
    cache = InvestorDailyFlowCache(page_budget=1)
    calls = []

    async def run(fetch, index):
        calls.append(fetch.request_identity[-1])
        clock[0] += 40
        return page([row("20261031" if index == 4 else "20261105")], "Y", str(index + 1))

    history = None
    for index in range(5):
        result = await cache.collect(code="005930", from_="20261101", to=today, run_page=run)
        history = history or cache.histories[("005930", today)]
        assert cache.histories[("005930", today)] is history
        assert result.daily_flow.pages_observed == index + 1
    assert calls == ["", "1", "2", "3", "4"]
    assert clock[0] == 200 and history.fresh == 40 and history.progressed == 200
    assert not result.daily_flow.can_continue and result.daily_flow.pagination == "incomplete"


async def test_idle_unfinished_continuation_expires_after_no_progress_ttl(monkeypatch):
    clock = [0.0]
    monkeypatch.setattr(module.time, "monotonic", lambda: clock[0])
    cache = InvestorDailyFlowCache(historical_ttl=60, page_budget=1)
    calls = []

    async def run(fetch, index):
        calls.append(fetch.request_identity[-1])
        return page([row()], "Y", str(index + 1))

    await collect(cache, run)
    history = cache.histories[("005930", "20261106")]
    clock[0] = 50
    await collect(cache, run)
    clock[0] = 111
    await collect(cache, run)
    assert calls == ["", "1", ""]
    assert cache.histories[("005930", "20261106")] is not history


async def test_narrow_polls_preserve_recent_broader_walk_until_its_boundary(monkeypatch):
    clock = [0.0]
    monkeypatch.setattr(module.time, "monotonic", lambda: clock[0])
    today = module.datetime.now(module.KST).strftime("%Y%m%d")
    cache = InvestorDailyFlowCache(page_budget=1)
    calls = []

    async def run(fetch, index):
        calls.append(fetch.request_identity[-1])
        return page([row(["20261104", "20261103", "20261020", "20260930"][index])], "Y", str(index + 1))

    async def request(from_):
        return (await cache.collect(code="005930", from_=from_, to=today, run_page=run)).daily_flow

    narrow = await request("20261105")
    history = cache.histories[("005930", today)]
    assert narrow.pages_observed == 1 and not narrow.can_continue
    clock[0] = 50
    broad = await request("20261001")
    assert broad.pages_observed == 2 and broad.can_continue
    for now in (61, 90):
        clock[0] = now
        narrow = await request("20261105")
        assert narrow.pages_observed == 2 and not narrow.can_continue
        assert cache.histories[("005930", today)] is history
    clock[0] = 100
    assert (await request("20261001")).pages_observed == 3
    clock[0] = 111
    assert not (await request("20261105")).can_continue
    clock[0] = 150
    boundary = await request("20261001")
    assert boundary.pages_observed == 4 and not boundary.can_continue and boundary.pagination == "incomplete"
    assert calls == ["", "1", "2", "3"]
    assert history.fresh == 0 and history.progressed == 150
    clock[0] = 151
    refreshed = await request("20261105")
    assert calls == ["", "1", "2", "3", ""] and refreshed.pages_observed == 1
    assert cache.histories[("005930", today)] is not history


async def test_abandoned_broader_walk_expires_despite_warm_narrow_polls(monkeypatch):
    clock = [0.0]
    monkeypatch.setattr(module.time, "monotonic", lambda: clock[0])
    today = module.datetime.now(module.KST).strftime("%Y%m%d")
    cache = InvestorDailyFlowCache(page_budget=1)
    calls = []

    async def run(fetch, index):
        calls.append(fetch.request_identity[-1])
        return page([row("20261104" if index == 0 else "20261103")], "Y", str(index + 1))

    async def request(from_, runner=run):
        return await cache.collect(code="005930", from_=from_, to=today, run_page=runner)

    await request("20261105")
    history = cache.histories[("005930", today)]
    clock[0] = 50
    await request("20261001")

    async def cancel(_fetch, _index):
        raise asyncio.CancelledError

    clock[0] = 60
    with pytest.raises(asyncio.CancelledError):
        await request("20260901", cancel)
    for now in (61, 90, 109):
        clock[0] = now
        await request("20261105")
        assert cache.histories[("005930", today)] is history
    assert calls == ["", "1"] and history.progressed == 50
    clock[0] = 110
    await request("20261105")
    assert calls == ["", "1", ""]
    assert cache.histories[("005930", today)] is not history
    clock[0] = 171
    await request("20261105")
    assert calls == ["", "1", "", ""]


async def test_bypass_broader_read_does_not_lease_completed_narrow_range(monkeypatch):
    clock = [0.0]
    monkeypatch.setattr(module.time, "monotonic", lambda: clock[0])
    today = module.datetime.now(module.KST).strftime("%Y%m%d")
    cache = InvestorDailyFlowCache()
    calls = []

    async def run(fetch, _index):
        calls.append(fetch.request_identity[-1])
        return page([row("20261104")], "Y", "older")

    await cache.collect(code="005930", from_="20261105", to=today, run_page=run)
    clock[0] = 50
    await cache.collect(code="005930", from_="20261001", to=today)
    clock[0] = 61
    await cache.collect(code="005930", from_="20261105", to=today, run_page=run)
    assert calls == ["", ""]


async def test_invalid_date_cannot_stop_range_and_page_cap_warning_survives_boundary():
    calls = []

    async def run(_fetch, index):
        calls.append(index)
        return page([row(None), row("20261105" if index == 0 else "20261031")], "Y", str(index + 1))

    cache = InvestorDailyFlowCache(max_pages=2)
    first = await collect(cache, run)
    assert first.unlocated_defect and first.can_continue
    second = await collect(cache, run)
    assert calls == [0, 1] and second.unlocated_defect and not second.can_continue
    assert second.pagination == "incomplete"
    assert {issue.reason for issue in second.data_warnings} == {"invalid_row", "page_budget"}


@pytest.mark.parametrize("date", ["20260230", "20261301", "20301101", "", "2026115", None])
async def test_bad_dates_are_unlocated_and_persist(date):
    async def run(_fetch, _index):
        return page([row(date), row()])

    cache = InvestorDailyFlowCache()
    first = await collect(cache, run)
    assert first.unlocated_defect and len(first.observations) == 1
    assert (await collect(cache, run)).unlocated_defect




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
