"""Calendar uncertainty, durable observations and holiday range/venue isolation."""
import datetime as dt
import json
from dataclasses import replace
from unittest.mock import AsyncMock

import httpx
import pytest

from hoga.api import trading_days
from hoga.live import kiwoom_rest_runtime, ranking_history, ranking_session
from hoga.live.kiwoom_rankings import KiwoomRankingsError, KiwoomRankingsFetcher, RankingRow, RankingSnapshot
from hoga.util.timeenc import KST

FRIDAY = dt.datetime(2026, 10, 30, 16, tzinfo=KST)
SUNDAY = dt.datetime(2026, 11, 1, 12, tzinfo=KST)


@pytest.fixture
def calendar(monkeypatch):
    days = {"20261029", "20261030"}
    monkeypatch.setattr(trading_days, "trading_days", lambda *_: days)
    return days


@pytest.mark.parametrize("now,venue,state,date", [
    (FRIDAY, "KRX", "open", "2026-10-30"),
    (FRIDAY.replace(hour=21), "KRX", "closed", "2026-10-30"),
    (FRIDAY.replace(hour=10), "KRX", "open", "2026-10-30"),
    (FRIDAY.replace(hour=8), "KRX", "preopen", "2026-10-29"),
    (FRIDAY.replace(hour=8), "UN", "open", "2026-10-30"),
    (SUNDAY, "KRX", "holiday", "2026-10-30"),
    (SUNDAY + dt.timedelta(days=1), "KRX", "calendar_unavailable", None),
    (SUNDAY + dt.timedelta(days=7), "KRX", "calendar_unavailable", None),
])
def test_shared_session_never_guesses_unknown_weekdays(calendar, tmp_path, now, venue, state, date):
    session = ranking_session.resolve(now, venue, tmp_path)
    assert session.state == state
    assert (session.date.isoformat() if session.date else None) == date


def test_known_holiday_and_preopen_follow_previous_session(calendar, tmp_path):
    calendar.add("20261103")
    holiday = ranking_session.resolve(SUNDAY + dt.timedelta(days=1), "KRX", tmp_path)
    assert holiday.state == "holiday" and holiday.date == FRIDAY.date()
    preopen = ranking_session.resolve(dt.datetime(2026, 11, 3, 8, tzinfo=KST), "KRX", tmp_path)
    assert preopen.state == "preopen" and preopen.date == FRIDAY.date()


def dated_snapshot(count=200, **changes):
    stamp = int(FRIDAY.timestamp() * 1000)
    return replace(RankingSnapshot(
        kind="change", market="all", direction="up", market_open=False, fetched_at_ms=stamp,
        rows=tuple(RankingRow(i, f"{i:06d}", str(i), 100, 1.0) for i in range(1, count + 1)),
        queried_count=count, has_more=True,
        basis=ranking_session.RankingBasis(session="closed", source="live",
            trading_date="2026-10-30", observed_at_ms=stamp),
    ), **changes)


async def test_live_fetch_persists_and_new_process_restores_without_vendor(calendar, tmp_path, monkeypatch):
    class Token:
        def get_token(self):
            return "test-token"

    class Scheduler:
        async def submit(self, **kwargs):
            return await kwargs["call"](None)

    monkeypatch.setattr(kiwoom_rest_runtime, "ensure_scheduler", lambda *_: Scheduler())
    calls = []
    def handler(req):
        calls.append(req)
        return httpx.Response(200, json={"return_code": 0, "pred_pre_flu_rt_upper": [
            {"stk_cd": f"{i:06d}", "stk_nm": str(i), "cur_prc": "100", "flu_rt": "1"}
            for i in range(1, 201)]})
    live = KiwoomRankingsFetcher(Token(), data_dir=tmp_path, _now=lambda: FRIDAY,
                                _transport=httpx.MockTransport(handler))
    restored = KiwoomRankingsFetcher(Token(), data_dir=tmp_path, _now=lambda: SUNDAY,
                                    _transport=httpx.MockTransport(handler))
    try:
        original = await live.get("change", "all", "up", limit=200)
        result = await restored.get("change", "all", "up", limit=100, allow_last_available=True)
        assert len(calls) == 1 and len(result.rows) == 100
        assert result.rows == original.rows[:100]
        assert result.fetched_at_ms == original.fetched_at_ms == int(FRIDAY.timestamp() * 1000)
        assert result.basis.source == "stored" and result.basis.session == "holiday"
        assert result.basis.trading_date == "2026-10-30"
        assert not result.market_open and result.has_more
        # Restoring does not write a new observation or relabel its time.
        assert len(list((tmp_path / "rankings").rglob("*.json"))) == 1
    finally:
        live.close()
        restored.close()


@pytest.mark.parametrize("kind", ["change", "surge", "volume", "value", "program", "institution", "foreign"])
@pytest.mark.parametrize("venue", ["KRX", "NXT", "UN"])
async def test_panel_can_read_last_provider_rows_without_creating_dated_history(
    calendar, tmp_path, monkeypatch, kind, venue,
):
    fetcher = KiwoomRankingsFetcher(object(), data_dir=tmp_path, _now=lambda: SUNDAY)
    rows = dated_snapshot(2).rows
    general = AsyncMock(return_value=(rows, 2, False))
    program = AsyncMock(return_value=(rows, False))
    investor = AsyncMock(return_value=rows)
    monkeypatch.setattr(fetcher, "_fetch_rankings", general)
    monkeypatch.setattr(fetcher, "_fetch_program", program)
    monkeypatch.setattr(fetcher, "_fetch_investor", investor)

    latest = await fetcher.get(kind, "all", "up", venue, allow_last_available=True)
    assert latest.rows == rows and not latest.market_open
    assert latest.basis.source == "provider" and latest.basis.session == "holiday"
    assert latest.basis.trading_date is None and latest.basis.observed_at_ms is None
    assert "2026-10-30" in latest.basis.message
    assert latest.venue == (None if kind in {"institution", "foreign"} else venue)
    assert latest.quote_venue == (venue if kind in {"institution", "foreign"} else None)
    assert await fetcher.get(kind, "all", "up", venue, allow_last_available=True) is latest
    assert general.await_count + program.await_count + investor.await_count == 1
    # Even a warm panel cache must not supply undated screener evidence.
    strict = await fetcher.get(kind, "all", "up", venue)
    assert strict.rows == () and strict.basis.source == "unavailable"
    ranking_history.save(tmp_path, latest, 100)
    assert not (tmp_path / "rankings").exists()


async def test_last_provider_cache_expands_and_expires_without_becoming_monday_evidence(
    calendar, tmp_path, monkeypatch,
):
    from hoga.live import kiwoom_rankings

    clock = 1000.0
    monkeypatch.setattr(kiwoom_rankings.time, "time", lambda: clock)
    now = SUNDAY
    fetcher = KiwoomRankingsFetcher(object(), data_dir=tmp_path, _now=lambda: now)
    mock = AsyncMock(return_value=(dated_snapshot().rows, 200, True))
    monkeypatch.setattr(fetcher, "_fetch_rankings", mock)
    await fetcher.get("change", "all", "up", limit=100, allow_last_available=True)
    await fetcher.get("change", "all", "up", limit=200, allow_last_available=True)
    await fetcher.get("change", "all", "down", limit=200, allow_last_available=True)
    assert mock.await_count == 3
    clock += 60
    await fetcher.get("change", "all", "up", limit=200, allow_last_available=True)
    assert mock.await_count == 4
    now += dt.timedelta(days=1)
    missing = await fetcher.get("change", "all", "up", allow_last_available=True)
    assert missing.rows == () and missing.basis.session == "calendar_unavailable"
    assert mock.await_count == 4
    calendar.add("20261102")
    now = now.replace(hour=8)
    preopen = await fetcher.get("change", "all", "up", allow_last_available=True)
    assert preopen.basis.source == "provider" and preopen.basis.session == "preopen"
    now = now.replace(hour=9)
    opened = await fetcher.get("change", "all", "up", allow_last_available=True)
    assert opened.basis.source == "live" and opened.basis.trading_date == "2026-11-02"
    assert opened is not preopen and mock.await_count == 6


def test_holiday_panel_route_fetches_last_rows_and_serializes_unknown_date(calendar, tmp_path, monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from hoga.live import api, lifecycle

    fetcher = KiwoomRankingsFetcher(object(), data_dir=tmp_path, _now=lambda: SUNDAY)
    monkeypatch.setattr(fetcher, "_fetch_rankings", AsyncMock(return_value=(dated_snapshot(2).rows, 2, False)))
    monkeypatch.setattr(api, "kiwoom_rankings_fetcher_instance", fetcher)
    app = FastAPI()
    app.include_router(api.build_router(get_status=lifecycle.get_status, data_dir=tmp_path))
    with TestClient(app) as client:
        response = client.get("/api/live/rankings", params={"kind": "change", "limit": 100})
    assert response.status_code == 200
    body = response.json()
    assert len(body["rows"]) == body["queried_count"] == 2
    assert body["basis"]["source"] == "provider" and body["basis"]["session"] == "holiday"
    assert body["basis"]["trading_date"] is None and body["basis"]["observed_at_ms"] is None


@pytest.mark.parametrize("market,direction,venue,limit", [
    ("kospi", "up", "KRX", 100), ("all", "down", "KRX", 100),
    ("all", "up", "UN", 100), ("all", "up", "KRX", 300),
])
def test_history_never_fabricates_a_different_scope_or_larger_range(
    calendar, tmp_path, market, direction, venue, limit,
):
    ranking_history.save(tmp_path, dated_snapshot(), 200)
    session = ranking_session.resolve(SUNDAY, venue, tmp_path)
    assert ranking_history.load(tmp_path, session, "change", market, direction, venue, limit) is None


def test_terminal_empty_snapshot_is_evidence_not_missing_history(calendar, tmp_path):
    ranking_history.save(tmp_path, dated_snapshot(0, has_more=False), 200)
    session = ranking_session.resolve(SUNDAY, "KRX", tmp_path)
    found = ranking_history.load(tmp_path, session, "change", "all", "up", "KRX", 200)
    assert found is not None and found.rows == () and found.basis.source == "stored"


@pytest.mark.parametrize("broken", ["json", "future_time", "wrong_date", "unverified"])
def test_invalid_or_undated_history_is_not_evidence(calendar, tmp_path, broken):
    ranking_history.save(tmp_path, dated_snapshot(), 200)
    path = next((tmp_path / "rankings").rglob("*.json"))
    value = json.loads(path.read_text())
    if broken == "json":
        path.write_text("{")
    else:
        basis = value["snapshot"]["basis"]
        if broken == "future_time":
            basis["observed_at_ms"] = value["snapshot"]["fetched_at_ms"] = int(SUNDAY.timestamp() * 1000)
        elif broken == "wrong_date":
            basis["trading_date"] = "2026-10-29"
        else:
            basis["source"] = "unavailable"
        path.write_text(json.dumps(value))
    session = ranking_session.resolve(SUNDAY, "KRX", tmp_path)
    assert ranking_history.load(tmp_path, session, "change", "all", "up", "KRX", 100) is None


async def test_unknown_calendar_never_calls_vendor_or_uses_older_session(calendar, tmp_path):
    ranking_history.save(tmp_path, dated_snapshot(), 200)
    def forbidden(_):
        raise AssertionError("Unknown weekday must not query an undated TR")
    fetcher = KiwoomRankingsFetcher(object(), data_dir=tmp_path, _now=lambda: SUNDAY + dt.timedelta(days=1),
                                  _transport=httpx.MockTransport(forbidden))
    try:
        snap = await fetcher.get("change", "all", "up")
        assert snap.rows == () and snap.basis.session == "calendar_unavailable"
        assert snap.fetched_at_ms == 0 and snap.basis.observed_at_ms is None
    finally:
        fetcher.close()


async def test_date_change_during_fetch_is_not_archived(calendar, tmp_path, monkeypatch):
    class Token:
        def get_token(self):
            return "fake-token"
    class Scheduler:
        async def submit(self, **kwargs):
            return await kwargs["call"](None)
    monkeypatch.setattr(kiwoom_rest_runtime, "ensure_scheduler", lambda *_: Scheduler())
    now = FRIDAY
    def handler(_):
        nonlocal now
        now += dt.timedelta(days=1)
        return httpx.Response(200, json={"return_code": 0, "pred_pre_flu_rt_upper": []})
    fetcher = KiwoomRankingsFetcher(Token(), data_dir=tmp_path, _now=lambda: now,
                                  _transport=httpx.MockTransport(handler))
    try:
        with pytest.raises(KiwoomRankingsError, match="거래일이 변경"):
            await fetcher.get("change", "all", "up")
        assert not (tmp_path / "rankings").exists()
    finally:
        fetcher.close()
