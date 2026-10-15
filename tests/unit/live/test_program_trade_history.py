import json

import httpx
import pytest
from fastapi import FastAPI

from hoga.live import program_trade_history as history
from hoga.live.kiwoom_errors import KiwoomRestError
from hoga.live.kiwoom_rest import KiwoomRestClient, Page
from hoga.live.program_trade_tape_api import build_router
from hoga.util.timeenc import hhmmssms_to_unix_ms


def vendor_row(**extra):
    return {
        "tm": "153001",
        "cur_prc": "-123000",
        "prm_netprps_qty_irds": "--115",
        "prm_netprps_qty": "+67000",
        "stex_tp": "통합",
        **extra,
    }


def vendor_page(rows, *, cont=False, key=""):
    return Page(rows=rows, raw={"stk_tm_prm_trde_trnsn": rows}, cont=cont, next_key=key)


def test_history_uses_supplier_changes_and_deduplicates_boundary_without_losing_equal_second_reports():
    a = vendor_row()
    b = vendor_row(prm_netprps_qty="+66885")
    rows = [
        vendor_row(tm="153010", prm_netprps_qty_irds="0"),
        a,
        a,
        b,
        vendor_row(tm="153000", cur_prc="", prm_netprps_qty_irds="+20"),
        vendor_row(tm="250000"),
        vendor_row(tm="bad"),
        vendor_row(prm_netprps_qty_irds=""),
    ]
    result = history.parse_page(
        vendor_page(rows, cont=True, key="next+/="), code="222800", date="20261015", venue="UN", next_key=None
    )
    assert [r.event_delta_qty for r in result.rows] == [-115, -115, 20]
    assert [r.price for r in result.rows] == [123000, 123000, None]
    assert len({r.event_id for r in result.rows}) == 3
    assert result.next_key == "next+/="
    assert result.latest_at_ms == hhmmssms_to_unix_ms("20261015", 153010000)
    repeated = history.parse_page(vendor_page([a]), code="222800", date="20261015", venue="UN", next_key=None)
    assert repeated.rows[0].event_id == result.rows[0].event_id


@pytest.mark.parametrize(
    "page,key",
    [
        (Page(rows=[], raw={}, cont=False, next_key=""), None),
        (vendor_page([], cont=True), None),
        (vendor_page([], cont=True, key="same"), "same"),
        (vendor_page([vendor_row(stex_tp="KRX")]), None),
    ],
)
def test_bad_shapes_venue_and_stuck_cursor_fail_visibly(page, key):
    with pytest.raises(KiwoomRestError):
        history.parse_page(page, code="222800", date="20261015", venue="UN", next_key=key)


@pytest.mark.parametrize("qty", ["1.5", "NaN", "Infinity", None, "bad", "+-115"])
def test_invalid_quantity_never_uses_a_cumulative_substitute(qty):
    result = history.parse_page(vendor_page([vendor_row(prm_netprps_qty_irds=qty)]),
                                code="222800", date="20261015", venue="UN", next_key=None)
    assert result.rows == []


@pytest.mark.asyncio
async def test_http_history_uses_capacity_for_every_page_and_preserves_vendor_cursor(tmp_path, monkeypatch):
    calls, submissions = [], []

    def respond(request):
        calls.append(
            (
                json.loads(request.content),
                request.headers["cont-yn"],
                request.headers["next-key"],
                request.headers["api-id"],
                request.url.path,
            )
        )
        is_next = request.headers["cont-yn"] == "Y"
        return httpx.Response(
            200,
            json={"return_code": 0, "stk_tm_prm_trde_trnsn": [vendor_row(tm="151000" if is_next else "153001")]},
            headers={"cont-yn": "N" if is_next else "Y", "next-key": "" if is_next else "opaque+/="},
        )

    class Token:
        def get_token(self):
            return "test-only"

    class Scheduler:
        async def submit(self, **kwargs):
            submissions.append((kwargs["key"], kwargs["api_id"], kwargs["priority"]))
            return await kwargs["call"](None)

    client = KiwoomRestClient(Token(), transport=httpx.MockTransport(respond))
    monkeypatch.setattr(history.kiwoom_rest_runtime, "ensure_rest_client", lambda _: client)
    monkeypatch.setattr(history.kiwoom_rest_runtime, "ensure_scheduler", lambda _: Scheduler())
    app = FastAPI()
    app.include_router(build_router(data_dir=tmp_path))
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as api:
            params = {"code": "222800", "date": "20261015", "venue": "UN"}
            first = await api.get("/api/live/program-trades/history", params=params)
            assert first.status_code == 200
            data = first.json()
            assert set(data) == {"code", "date", "venue", "rows", "next_key", "latest_at_ms"}
            assert data["rows"][0]["event_delta_qty"] == -115
            second = await api.get("/api/live/program-trades/history", params={**params, "next_key": data["next_key"]})
            assert second.status_code == 200
            assert second.json()["next_key"] is None
            assert second.json()["rows"][0]["t_ms"] < data["rows"][0]["t_ms"]
            assert calls == [
                (
                    {"stk_cd": "222800_AL", "date": "20261015", "amt_qty_tp": "2"},
                    "N",
                    "",
                    "ka90008",
                    "/api/dostk/mrkcond",
                ),
                (
                    {"stk_cd": "222800_AL", "date": "20261015", "amt_qty_tp": "2"},
                    "Y",
                    "opaque+/=",
                    "ka90008",
                    "/api/dostk/mrkcond",
                ),
            ]
            assert len(submissions) == 2 and all(s[1:] == ("ka90008", "user_visible") for s in submissions)
            assert submissions[0][0] != submissions[1][0]
            for venue, suffix in (("KRX", ""), ("NXT", "_NX")):
                await api.get("/api/live/program-trades/history", params={**params, "venue": venue})
                assert calls[-1][0]["stk_cd"] == "222800" + suffix
            assert (
                await api.get("/api/live/program-trades/history", params={**params, "date": "20260230"})
            ).status_code == 422
            monkeypatch.setattr(history.kiwoom_rest_runtime, "ensure_rest_client", lambda _: None)
            unavailable = await api.get("/api/live/program-trades/history", params=params)
            assert unavailable.status_code == 503  # never pretend an auth/provider failure is the end
    finally:
        await client.aclose()
