import json
from datetime import datetime

import httpx
import pytest
from fastapi import FastAPI

from hoga.live import trade_history as history, trade_history_api as api_module
from hoga.live.kiwoom_errors import KiwoomRestError
from hoga.live.kiwoom_rest import KiwoomRestClient, Page
from hoga.util.timeenc import KST


def vendor_row(**extra):
    return {
        "tm": "160100",
        "cur_prc": "-123000",
        "pred_pre": "-18000",
        "cntr_trde_qty": "-10",
        "acc_trde_qty": "1700000",
        "stex_tp": "통합",
        **extra,
    }


def page(rows, cont=False, key=""):
    return Page(rows=rows, raw={"cntr_infr": rows}, cont=cont, next_key=key)


def test_preserves_equal_second_executions_and_uses_native_quantity_side_and_previous_close():
    a = vendor_row()
    b = vendor_row(acc_trde_qty="1700010", cntr_trde_qty="+10")
    result = history.parse_page(
        page([b, a, a], True, "next+/="), code="222800", date="20261015", venue="UN", next_key=None
    )
    assert [r.cum_volume for r in result.rows] == [1700010, 1700000]
    assert [r.qty for r in result.rows] == [10, 10]
    assert [r.side for r in result.rows] == [1, -1]
    assert all(r.price == 123000 for r in result.rows)
    assert result.latest_volume == 1700010
    assert result.latest_at_ms == int(datetime(2026, 10, 15, 16, 1, tzinfo=KST).timestamp() * 1000)
    assert result.prev_close == 141000
    assert result.next_key == "next+/="
    repeat = history.parse_page(page([a]), code="222800", date="20261015", venue="UN", next_key=None)
    assert repeat.rows[0].event_id == result.rows[1].event_id


@pytest.mark.parametrize(
    "patch",
    [
        {"tm": "240000"},
        {"tm": "bad"},
        {"cur_prc": ""},
        {"cur_prc": "0"},
        {"cntr_trde_qty": "0"},
        {"cntr_trde_qty": "NaN"},
        {"cntr_trde_qty": "1.5"},
    ],
)
def test_invalid_executions_are_not_reconstructed_from_cumulative_fields(patch):
    result = history.parse_page(page([vendor_row(**patch)]), code="222800", date="20261015", venue="UN", next_key=None)
    assert result.rows == []


@pytest.mark.parametrize(
    "p,key",
    [
        (Page(rows=[], raw={}, cont=False, next_key=""), None),
        (page([], True), None),
        (page([], True, "same"), "same"),
    (page([vendor_row(stex_tp="INVALID")]), None),
    ],
)
def test_bad_shape_market_or_continuation_is_an_error(p, key):
    with pytest.raises(KiwoomRestError):
        history.parse_page(p, code="222800", date="20261015", venue="UN", next_key=key)


def test_unified_history_accepts_constituent_venues_but_single_market_does_not():
    p = page([vendor_row(stex_tp="KRX"), vendor_row(stex_tp="NXT", acc_trde_qty="1700010")])
    result = history.parse_page(p, code="222800", date="20261015", venue="UN", next_key=None)
    assert len(result.rows) == 2
    with pytest.raises(KiwoomRestError):
        history.parse_page(p, code="222800", date="20261015", venue="KRX", next_key=None)


@pytest.mark.asyncio
async def test_actual_http_shape_continuation_governor_and_today_only(tmp_path, monkeypatch):
    calls, submissions = [], []

    class Clock(datetime):
        @classmethod
        def now(cls, tz=None):
            return datetime(2026, 10, 15, 16, 10, tzinfo=KST)

    monkeypatch.setattr(api_module, "datetime", Clock)
    monkeypatch.setattr(api_module, "is_trading_day", lambda *_: True)

    def respond(request):
        body = json.loads(request.content)
        calls.append(
            (body, request.headers["api-id"], request.headers["cont-yn"], request.headers["next-key"], request.url.path)
        )
        more = request.headers["cont-yn"] == "N"
        label = {"222800_AL": "통합", "222800_NX": "NXT", "222800": "KRX"}[body["stk_cd"]]
        return httpx.Response(
            200,
            json={"return_code": 0, "cntr_infr": [vendor_row(stex_tp=label, tm="160100" if more else "155900")]},
            headers={"cont-yn": "Y" if more else "N", "next-key": "opaque+/=" if more else ""},
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
    app.include_router(api_module.build_router(data_dir=tmp_path))
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as api:
            params = {"code": "222800", "date": "20261015", "venue": "UN"}
            first = await api.get("/api/live/trades/history", params=params)
            assert first.status_code == 200
            data = first.json()
            assert set(data) == {
                "code",
                "date",
                "venue",
                "rows",
                "next_key",
                "latest_at_ms",
                "latest_volume",
                "prev_close",
            }
            assert data["rows"][0]["side"] == -1
            second = await api.get("/api/live/trades/history", params={**params, "next_key": data["next_key"]})
            assert second.status_code == 200
            assert second.json()["next_key"] is None
            assert second.json()["rows"][0]["t_ms"] < data["rows"][0]["t_ms"]
            assert calls[:2] == [
                ({"stk_cd": "222800_AL"}, "ka10003", "N", "", "/api/dostk/stkinfo"),
                ({"stk_cd": "222800_AL"}, "ka10003", "Y", "opaque+/=", "/api/dostk/stkinfo"),
            ]
            assert len(submissions) == 2 and all(s[1:] == ("ka10003", "user_visible") for s in submissions)
            for venue, suffix in (("KRX", ""), ("NXT", "_NX")):
                result = await api.get("/api/live/trades/history", params={**params, "venue": venue})
                assert result.status_code == 200
                assert calls[-1][0]["stk_cd"] == "222800" + suffix
            assert (await api.get("/api/live/trades/history", params={**params, "date": "20261014"})).status_code == 422
            assert (await api.get("/api/live/trades/history", params={**params, "date": "20260230"})).status_code == 422
            monkeypatch.setattr(history.kiwoom_rest_runtime, "ensure_rest_client", lambda _: None)
            assert (await api.get("/api/live/trades/history", params=params)).status_code == 503
            monkeypatch.setattr(api_module, "is_trading_day", lambda *_: False)
            closed = await api.get("/api/live/trades/history", params=params)
            assert closed.status_code == 200 and closed.json()["rows"] == []
    finally:
        await client.aclose()
