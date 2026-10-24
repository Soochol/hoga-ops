"""Exercise the real HTTP contract without broker credentials or sockets."""

from datetime import date, timedelta
from http import HTTPStatus

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from httpx import URL

from hoga.live.api import LiveIndexCandlesResponse, build_router
from hoga.live.us_daily_candles import UsDailyBar, UsDailyMetadata
from hoga.live.us_index_minutes import UsMinuteMetadata
from hoga.live.us_market_api import UsMarketApi


@pytest.fixture
def window(monkeypatch):
    bars = [UsDailyBar(trading_date=(date(2026, 2, 1) + timedelta(days=i)).strftime("%Y%m%d"),
                       t_ms=1_770_000_000_000 + i * 86_400_000,
                       open=100, high=120, low=90, close=110 + i / 100) for i in range(240)]
    meta = UsDailyMetadata(source="kis", price_basis="index_points", currency="index_points",
                           session_scope="cash_index", refresh_status="normal")
    minute_meta = UsMinuteMetadata(refresh_interval_ms=2000)
    calls = []

    async def chart(self, index, start, end, timeframe):
        calls.append((index.id, start, end, timeframe))
        return list(bars), meta, minute_meta

    monkeypatch.setattr(UsMarketApi, "index_chart", chart)
    app = FastAPI()
    app.include_router(build_router(get_status=lambda: None, get_buffer=lambda _: None))
    with TestClient(app) as client:
        yield client, bars, meta, minute_meta, calls


BASE = "/api/live/index-candles?index_id=SOX&timeframe=D&from=20260201&to=20261024"


def test_tail_keeps_full_metadata_and_old_clients_keep_full_history(window):
    client, bars, _, _, calls = window
    initial = client.get(BASE)
    assert initial.status_code == HTTPStatus.OK
    full = initial.json()
    assert len(full["candles"]) == len(bars)
    assert full["daily_history_unchanged"] is False
    bars[-1] = bars[-1].model_copy(update={"close": 119.75})
    tail = client.get(URL(BASE).copy_add_param("daily_history_revision", full["daily_history_revision"]))
    body = tail.json()
    assert body["candles"] == [bars[-1].model_dump()]
    assert body["daily_history_unchanged"] is True
    assert body["daily_history_revision"] == full["daily_history_revision"]
    assert body["daily_metadata"] == full["daily_metadata"]
    assert body["minute_metadata"]["refresh_interval_ms"] == 2000
    assert len(tail.content) < len(initial.content) * 0.1
    assert len(client.get(BASE).json()["candles"]) == len(bars)
    assert len(calls) == 3  # Same original composition path, once per HTTP request.


@pytest.mark.parametrize("change", ["correction", "rollover", "backfill", "truncation"])
def test_changed_history_sends_full_authoritative_window(window, change):
    client, bars, _, _, _ = window
    revision = client.get(BASE).json()["daily_history_revision"]
    if change == "correction":
        bars[0] = bars[0].model_copy(update={"high": 125, "volume": 321})
    elif change == "rollover":
        bars.append(bars[-1].model_copy(update={"trading_date": "20261024", "t_ms": bars[-1].t_ms + 86_400_000}))
    elif change == "backfill":
        bars.insert(0, bars[0].model_copy(update={"trading_date": "20260131", "t_ms": bars[0].t_ms - 86_400_000}))
    else:
        del bars[0]
    body = client.get(URL(BASE).copy_add_param("daily_history_revision", revision)).json()
    assert body["daily_history_unchanged"] is False
    assert body["daily_history_revision"] != revision
    assert len(body["candles"]) == len(bars)


@pytest.mark.parametrize("replacement", ["index_id=SOX:index_id=SP500", "from=20260201:from=20260101",
                                         "to=20261024:to=20261023"])
def test_revision_is_bound_to_index_and_range(window, replacement):
    client, bars, _, _, _ = window
    revision = client.get(BASE).json()["daily_history_revision"]
    old, new = replacement.split(":")
    body = client.get(URL(BASE.replace(old, new)).copy_add_param("daily_history_revision", revision)).json()
    assert body["daily_history_unchanged"] is False
    assert len(body["candles"]) == len(bars)


def test_failure_metadata_bypass_empty_and_restart_require_no_new_state(window):
    client, bars, meta, minute_meta, _ = window
    revision = client.get(BASE).json()["daily_history_revision"]
    minute_meta.refresh_status = "stale"
    minute_meta.refresh_interval_ms = 60_000
    meta.refresh_status = "bypass"
    body = client.get(URL(BASE).copy_add_param("daily_history_revision", revision)).json()
    assert body["daily_history_unchanged"] is True
    assert body["minute_metadata"]["refresh_status"] == "stale"
    assert body["minute_metadata"]["refresh_interval_ms"] == 60_000
    assert body["daily_metadata"]["refresh_status"] == "bypass"
    unknown = client.get(URL(BASE).copy_add_param("daily_history_revision", "unknown-or-old-version")).json()
    assert unknown["daily_history_unchanged"] is False
    assert len(unknown["candles"]) == len(bars)
    bars.clear()
    empty = client.get(BASE).json()
    assert not empty["candles"]
    empty_tail = client.get(URL(BASE).copy_add_param("daily_history_revision", empty["daily_history_revision"])).json()
    assert empty_tail["daily_history_unchanged"] is True and not empty_tail["candles"]


@pytest.mark.parametrize("timeframe", ["1m", "5m", "W", "M"])
def test_other_us_periods_do_not_opt_in(window, timeframe):
    client, bars, _, _, _ = window
    revision = client.get(BASE).json()["daily_history_revision"]
    body = client.get(URL(BASE.replace("timeframe=D", f"timeframe={timeframe}")).copy_add_param(
        "daily_history_revision", revision)).json()
    assert len(body["candles"]) == len(bars)
    assert "daily_history_revision" not in body and "daily_history_unchanged" not in body


def test_domestic_wire_shape_is_unchanged():
    body = LiveIndexCandlesResponse(index_id="KOSPI", **{"from": "20261001"}, to="20261024", timeframe="D").model_dump()
    assert "daily_history_revision" not in body and "daily_history_unchanged" not in body
