import asyncio
import json
from contextlib import aclosing

import httpx
import pytest
from fastapi import FastAPI

from hoga.live import api as live_api, lifecycle
from hoga.live.investor_daily_flow import InvestorDailyFlowCache
from hoga.live.kiwoom_rest import KiwoomRestClient, Page


class Provider:
    def get_token(self):
        return "synthetic-token"


def source_row(date="20261105"):
    return {
        "dt": date, "orgn": "36", "frgnr_invsr": "17", "natfor": "-5", "ind_invsr": "-50",
        "etc_corp": "2", "fnnc_invt": "1", "insrnc": "2", "invtrt": "3", "etc_fnnc": "4",
        "bank": "5", "penfnd_etc": "6", "samo_fund": "7", "natn": "8",
    }


def setup_app(tmp_path, monkeypatch, vendor):
    submissions = []

    async def run(_scheduler, **kwargs):
        submissions.append(kwargs["key"])
        return await kwargs["fetch_fn"](kwargs["client"])

    monkeypatch.setattr(live_api.live_settings, "rest_bypass_enabled", lambda _: False)
    monkeypatch.setattr(live_api.kiwoom_rest_runtime, "ensure_rest_client", lambda _: vendor)
    monkeypatch.setattr(live_api.kiwoom_rest_runtime, "ensure_scheduler", lambda _: object())
    monkeypatch.setattr(live_api.kiwoom_access, "run_with_capacity", run)
    app = FastAPI()
    app.include_router(live_api.build_router(get_status=lifecycle.get_status, data_dir=tmp_path))
    return app, submissions


def url(from_="20261001", to="20261106", code="00088K", **params):
    return "/api/live/past-investor-net?" + str(httpx.QueryParams({"code": code, "from": from_, "to": to, **params}))


async def test_real_http_one_chain_progressive_batches_full_table_projection_and_cache_reuse(tmp_path, monkeypatch):
    requests = []
    dates = ["20261105", "20261029", "20261104", "20261101", "20261103", "20261030", "20261102", "20261031"]

    def handler(request):
        index = len(requests)
        requests.append(request)
        assert request.headers["next-key"] == (str(index) if index else "")
        return httpx.Response(200, json={"return_code": 0, "stk_invsr_orgn": [source_row(dates[index])]}, headers={
            "cont-yn": "N" if index == 7 else "Y", "next-key": str(index + 1),
        })

    async with aclosing(KiwoomRestClient(Provider(), transport=httpx.MockTransport(handler))) as vendor:
        app, submissions = setup_app(tmp_path, monkeypatch, vendor)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            first = await client.get(url())
            assert first.status_code == 200
            wire = first.json()
            assert wire["from"] == "20261001" and "from_" not in wire
            flow = wire["daily_flow"]
            assert flow["pages_observed"] == 1 and flow["pagination"] == "incomplete" and flow["can_continue"]
            assert len(requests) == 1 and len(wire["points"]) == len(flow["observations"]) == 1
            assert flow["unit"] == wire["unit"] == "qty_shares" and flow["trade_side"] == wire["trade_side"] == "net"
            assert flow["source"] == "kiwoom_ka10059" and flow["provider_scope"] == "KRX"
            assert flow["observations"][0]["foreign_net_shares"] == wire["points"][0]["foreign_net"] == 12
            assert flow["observations"][0]["institution_net_shares"] == wire["points"][0]["institution_net"] == 36
            assert wire["points"][0]["breakdown"] == {
                "individual": -50, "native_foreign": -5, "other_corp": 2, "fin_invest": 1, "insurance": 2,
                "trust": 3, "other_fin": 4, "bank": 5, "pension": 6, "private_fund": 7, "nation": 8,
            }
            second = (await client.get(url(from_="20261101"))).json()
            assert len(requests) == 2 and second["daily_flow"]["pages_observed"] == 2
            assert (
                second["daily_flow"]["pagination"] == "incomplete" and second["daily_flow"]["can_continue"] is False
                and second["data_warnings"] == second["daily_flow"]["data_warnings"] == []
            )
            third = (await client.get(url())).json()
            assert len(requests) == 8 and third["daily_flow"]["pagination"] == "covered"
            assert third["daily_flow"]["can_continue"] is False
            assert len(third["points"]) == 8 and third["data_warnings"] == []
            warm = await asyncio.gather(client.get(url()), client.get(url(from_="20261101")))
            assert len(requests) == 8
            assert warm[0].json()["cached_batches"] == ["20261001__20261106"]
            assert warm[0].json()["fresh_batches"] == []
            assert len(warm[1].json()["daily_flow"]["observations"]) == 5
            removed = await client.get("/api/live/investor-daily-flow?code=00088K&from=20261001&to=20261106")
            assert removed.status_code == 404
            assert (await client.get(url(from_="20260230"))).status_code == 422
            assert (await client.get(url(code="bad"))).status_code == 422
            assert all(json.loads(request.content) == {
                "stk_cd": "00088K", "dt": "20261106", "amt_qty_tp": "2", "trde_tp": "0", "unit_tp": "1",
            } for request in requests)
            assert len(set(submissions)) == 8 and submissions[0][1][-1] == "" and submissions[1][1][-1] == "1"
            monkeypatch.setattr(live_api.live_settings, "rest_bypass_enabled", lambda _: True)

            def forbidden(_):
                raise AssertionError("cache-only must not initialize a client")

            monkeypatch.setattr(live_api.kiwoom_rest_runtime, "ensure_rest_client", forbidden)
            bypass = (await client.get(url())).json()
            assert bypass["points"] == third["points"] and bypass["daily_flow"]["pagination"] == "covered"
            assert bypass["data_warnings"][0]["reason"] == "rest_bypassed"
            cold = (await client.get(url(code="005930"))).json()
            assert cold["points"] == [] and cold["daily_flow"]["can_continue"] is False
            assert cold["daily_flow"]["data_warnings"][0]["reason"] == "unavailable"
            assert len(requests) == 8


async def test_real_http_other_five_modes_keep_independent_vendor_parameters_and_wire(tmp_path, monkeypatch):
    requests = []

    def handler(request):
        requests.append(json.loads(request.content))
        return httpx.Response(200, json={"return_code": 0, "stk_invsr_orgn": [source_row()]}, headers={"cont-yn": "N"})

    async with aclosing(KiwoomRestClient(Provider(), transport=httpx.MockTransport(handler))) as vendor:
        app, _ = setup_app(tmp_path, monkeypatch, vendor)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            for attempt in range(2):
                for axis, amt_qty, unit in [("qty", "2", "qty_shares"), ("amount", "1", "amt_mwon")]:
                    for side in ["net", "buy", "sell"]:
                        response = await client.get(url(from_="20261105", to="20261105", axis=axis, trade_side=side))
                        assert response.status_code == 200
                        wire = response.json()
                        assert wire["unit"] == unit and wire["trade_side"] == side
                        assert ("daily_flow" in wire) == (axis == "qty" and side == "net")
                        assert wire["points"][0]["foreign_net"] == (12 if side == "net" else 22)
                        if attempt == 0:
                            assert requests[-1]["amt_qty_tp"] == amt_qty
            assert len(requests) == 6
            assert {(request["amt_qty_tp"], request["trde_tp"], request["unit_tp"]) for request in requests} == {
                (axis, side, "1") for axis in ["1", "2"] for side in ["0", "1", "2"]
            }


async def test_http_cancellation_retries_unaccepted_cursor_without_losing_first_page(tmp_path, monkeypatch):
    entered = asyncio.Event()
    requests = []

    async def handler(request):
        requests.append(request.headers["next-key"])
        if len(requests) == 2:
            entered.set()
            await asyncio.Future()
        return httpx.Response(200, json={"return_code": 0, "stk_invsr_orgn": [source_row()]}, headers={
            "cont-yn": "Y" if len(requests) == 1 else "N", "next-key": "older",
        })

    async with aclosing(KiwoomRestClient(Provider(), transport=httpx.MockTransport(handler))) as vendor:
        app, _ = setup_app(tmp_path, monkeypatch, vendor)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            first = (await client.get(url())).json()
            task = asyncio.create_task(client.get(url()))
            await entered.wait()
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
            done = (await client.get(url())).json()
            assert requests == ["", "older", "older"]
            assert done["daily_flow"]["pagination"] == "covered"
            assert done["points"] == first["points"]


async def test_total_page_and_row_bounds_do_not_invent_coverage():
    calls = []

    async def run(_fetch, index):
        calls.append(index)
        return Page([], True, str(index + 1), raw={"stk_invsr_orgn": []}, raw_cont_yn="Y")

    cache = InvestorDailyFlowCache()
    lengths = []
    for _ in range(23):
        result = await cache.collect(code="005930", from_="20261101", to="20261106", run_page=run)
        lengths.append(len(calls))
    assert lengths[:3] == [1, 7, 13] and lengths[-1] == 128
    assert result.daily_flow.pagination == "incomplete" and not result.daily_flow.can_continue
    assert result.daily_flow.data_warnings[-1].reason == "page_budget"

    async def oversized(_fetch, _index):
        return Page([], False, "", raw={"stk_invsr_orgn": [source_row(), source_row("20261104")]}, raw_cont_yn="N")

    bounded = InvestorDailyFlowCache(max_rows=1)
    result = await bounded.collect(code="005930", from_="20261101", to="20261106", run_page=oversized)
    assert result.points == [] and result.daily_flow.pagination == "incomplete"
    assert result.daily_flow.pages_observed == 0 and result.daily_flow.data_warnings[-1].reason == "invalid_page"


async def test_shared_http_preserves_null_zero_conflict_independence_and_first_table_row(tmp_path, monkeypatch):
    rows = [
        {**source_row(), "orgn": "0"},
        {**source_row(), "orgn": "1"},
        {**source_row("20261104"), "orgn": "0", "natfor": ""},
        {**source_row("20261103"), "orgn": "", "frgnr_invsr": "0", "natfor": "0"},
    ]
    async with aclosing(KiwoomRestClient(Provider(), transport=httpx.MockTransport(
        lambda _: httpx.Response(200, json={"return_code": 0, "stk_invsr_orgn": rows}, headers={"cont-yn": "N"}),
    ))) as vendor:
        app, _ = setup_app(tmp_path, monkeypatch, vendor)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            wire = (await client.get(url())).json()
            flow = wire["daily_flow"]
            assert flow["pagination"] == "covered" and flow["unlocated_defect"] is False
            assert [(row["institution_net_shares"], row["foreign_net_shares"]) for row in flow["observations"]] == [
                (None, 0), (0, None), (None, 12),
            ]
            assert {(warning["reason"], warning["subject"]) for warning in flow["data_warnings"]} == {
                ("duplicate_conflict", "institution"), ("invalid_row", "institution"), ("invalid_row", "foreign"),
            }
            assert wire["points"][-1]["institution_net"] == 0
            assert wire["points"][-1]["breakdown"]["nation"] == 8


async def test_snapshot_mutation_cannot_poison_strict_or_nested_table_cache():
    async def run(_fetch, _index):
        return Page([], False, "", raw={"stk_invsr_orgn": [source_row()]}, raw_cont_yn="N")

    cache = InvestorDailyFlowCache()
    first = await cache.collect(code="005930", from_="20261101", to="20261106", run_page=run)
    first.points[0].breakdown.nation = 999
    first.daily_flow.observations[0].institution_net_shares = 999
    warm = await cache.collect(code="005930", from_="20261101", to="20261106", run_page=run)
    assert warm.points[0].breakdown.nation == 8
    assert warm.daily_flow.observations[0].institution_net_shares == 36


async def test_concurrent_http_ranges_share_accepted_chain_and_snapshot_isolation(tmp_path, monkeypatch):
    entered, release = asyncio.Event(), asyncio.Event()
    cursors = []

    async def handler(request):
        cursor = request.headers["next-key"]
        cursors.append(cursor)
        if not cursor:
            entered.set()
            await release.wait()
        return httpx.Response(200, json={"return_code": 0, "stk_invsr_orgn": [source_row(
            "20261104" if cursor else "20261105",
        )]}, headers={"cont-yn": "N" if cursor else "Y", "next-key": "older"})

    async with aclosing(KiwoomRestClient(Provider(), transport=httpx.MockTransport(handler))) as vendor:
        app, _ = setup_app(tmp_path, monkeypatch, vendor)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            first = asyncio.create_task(client.get(url(from_="20261101")))
            await entered.wait()
            second = asyncio.create_task(client.get(url(from_="20261001")))
            await asyncio.sleep(0)
            release.set()
            narrow, broad = await asyncio.gather(first, second)
            assert cursors == ["", "older"]
            assert narrow.json()["daily_flow"]["pages_observed"] == 1
            assert broad.json()["daily_flow"]["pages_observed"] == 2
            assert len(narrow.json()["points"]) == 1 and len(broad.json()["points"]) == 2
