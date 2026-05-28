"""Stage 7-α / 7-β — /api/live router."""
import asyncio

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


def _make_test_app(get_status_fn=None, control_fn=None):
    """Mount the live router on a bare FastAPI for isolated testing."""
    from hoga.live import lifecycle
    from hoga.live.api import build_router

    app = FastAPI()
    app.include_router(
        build_router(
            get_status=get_status_fn or lifecycle.get_status,
            on_control=control_fn,
        )
    )
    return app


def test_get_live_status_returns_running_false_initially() -> None:
    from hoga.live import lifecycle
    lifecycle.reset_for_tests()

    app = _make_test_app()
    with TestClient(app) as c:
        r = c.get("/api/live/status")
        assert r.status_code == 200
        body = r.json()
        assert body["running"] is False
        assert body["watchlist_count"] == 0
        assert body["kis_calls_today"] == 0


def test_post_live_control_dispatches_action() -> None:
    recorded: list[str] = []

    async def fake_control(action: str) -> None:
        recorded.append(action)

    app = _make_test_app(control_fn=fake_control)
    with TestClient(app) as c:
        r = c.post("/api/live/control", json={"action": "stop"})
        assert r.status_code == 200
        assert recorded == ["stop"]


async def _async_noop(action: str) -> None:
    pass


def test_post_live_control_rejects_unknown_action() -> None:
    app = _make_test_app(control_fn=_async_noop)
    with TestClient(app) as c:
        r = c.post("/api/live/control", json={"action": "nuke"})
        assert r.status_code == 422  # pydantic validation error


def test_live_router_registered_on_full_app(tmp_path) -> None:
    """create_app should mount /api/live/status."""
    from hoga.api.app import create_app
    from hoga.live import lifecycle

    lifecycle.reset_for_tests()
    app = create_app(tmp_path)
    with TestClient(app) as c:
        r = c.get("/api/live/status")
        assert r.status_code == 200
        assert r.json()["running"] is False


def test_get_live_snapshot_returns_404_when_no_data(tmp_path) -> None:
    """No publish yet → 404."""
    from hoga.api.app import create_app
    from hoga.live import lifecycle

    lifecycle.reset_for_tests()
    app = create_app(tmp_path)
    with TestClient(app) as c:
        r = c.get("/api/live/snapshot?code=005930")
        assert r.status_code == 404


@pytest.mark.asyncio
async def test_get_live_snapshot_returns_buffered_latest(tmp_path) -> None:
    """After publish, GET /snapshot returns the latest entry."""
    from hoga.api.app import create_app
    from hoga.live import lifecycle
    from hoga.live.snapshot import LiveSnapshot, SnapshotKind

    lifecycle.reset_for_tests()
    buf = lifecycle.get_buffer()
    await buf.publish("005930", [
        LiveSnapshot(t_ms=12345, kind=SnapshotKind.OB, payload={"total_bid_qty": 1000}),
        LiveSnapshot(t_ms=12345, kind=SnapshotKind.TRADE, payload={"trades": [{"price": 100}]}),
        LiveSnapshot(t_ms=12345, kind=SnapshotKind.BROKER, payload={"buy_top": []}),
    ])

    app = create_app(tmp_path)
    with TestClient(app) as c:
        r = c.get("/api/live/snapshot?code=005930")
        assert r.status_code == 200
        body = r.json()
        assert body["code"] == "005930"
        assert body["t_ms"] == 12345
        assert body["orderbook"]["total_bid_qty"] == 1000
        assert body["recent_trades"] == [{"price": 100}]


@pytest.mark.asyncio
async def test_get_live_series_returns_buffered_arrays(tmp_path) -> None:
    from hoga.api.app import create_app
    from hoga.live import lifecycle
    from hoga.live.snapshot import LiveSnapshot, SnapshotKind

    lifecycle.reset_for_tests()
    buf = lifecycle.get_buffer()
    for tick in range(3):
        t = (tick + 1) * 10_000
        await buf.publish("005930", [
            LiveSnapshot(t_ms=t, kind=SnapshotKind.OB, payload={"total_bid_qty": 100 + tick}),
            LiveSnapshot(t_ms=t, kind=SnapshotKind.TRADE, payload={"trades": []}),
            LiveSnapshot(t_ms=t, kind=SnapshotKind.BROKER, payload={"buy_top": []}),
        ])

    app = create_app(tmp_path)
    with TestClient(app) as c:
        r = c.get("/api/live/series?code=005930&date=20260527")
        assert r.status_code == 200
        body = r.json()
        assert body["code"] == "005930"
        assert body["date"] == "20260527"
        assert body["is_open"] is True  # session_close_ms None while live
        assert body["session_close_ms"] is None
        assert len(body["snapshots"]) == 3
        assert body["snapshots"][0]["total_bid_qty"] == 100


@pytest.mark.asyncio
async def test_get_live_stream_emits_published_snapshots() -> None:
    """The SSE stream inner generator yields live_snapshot events for published data."""
    import json as _json

    from hoga.live.buffer import LiveBuffer
    from hoga.live.snapshot import LiveSnapshot, SnapshotKind

    buf = LiveBuffer()
    q = buf.subscribe("005930")

    # Publish a snapshot BEFORE starting the generator so the queue is pre-loaded
    await buf.publish("005930", [
        LiveSnapshot(t_ms=42, kind=SnapshotKind.OB, payload={"total_bid_qty": 999}),
    ])

    # Replicate the inner stream() generator logic from the endpoint
    async def _stream_one():
        """Read one entry from the queue and return the SSE event dict."""
        entry = await asyncio.wait_for(q.get(), timeout=1.0)
        return {"event": "live_snapshot", "data": _json.dumps(entry)}

    sse_event = await _stream_one()
    buf.unsubscribe("005930", q)

    assert sse_event["event"] == "live_snapshot"
    payload = _json.loads(sse_event["data"])
    assert payload["t_ms"] == 42
    assert payload["total_bid_qty"] == 999


# ----- /api/live/past-candles -----

import datetime
from hoga.live.kis_models import KisCandle


def _today_kst_yyyymmdd() -> str:
    kst = datetime.timezone(datetime.timedelta(hours=9))
    return datetime.datetime.now(kst).strftime("%Y%m%d")


class _FakeKisForPast:
    """Stub KIS client returning deterministic minute bars per date."""

    def __init__(self):
        self.calls: list[str] = []  # records date arg per call

    async def fetch_past_minute_candles(self, code: str, date_yyyymmdd: str) -> list[KisCandle]:
        self.calls.append(date_yyyymmdd)
        # KST 09:00 of the requested date — matches the real KIS shape so
        # PastCandlesCache's date-match guard (the "evict stale" check from
        # f63ed15 follow-up) treats this cache entry as valid on hit.
        kst = datetime.timezone(datetime.timedelta(hours=9))
        y, m, d = int(date_yyyymmdd[:4]), int(date_yyyymmdd[4:6]), int(date_yyyymmdd[6:8])
        t_ms = int(datetime.datetime(y, m, d, 9, 0, tzinfo=kst).timestamp() * 1000)
        return [KisCandle(t_ms=t_ms, open=100, high=110, low=95, close=105, volume=10)]


def _past_app(tmp_path, fake_kis):
    """Build a minimal FastAPI mounting only the /api/live router.

    Mirrors `_make_test_app` so we DO NOT trigger create_app's scheduler /
    capture pool / poller / KRX-network side effects. data_dir is `tmp_path`
    so the past-candles cache writes into the test sandbox.
    """
    from fastapi import FastAPI
    from hoga.live import lifecycle
    from hoga.live.api import build_router

    lifecycle.reset_for_tests()
    lifecycle.set_kis_client(fake_kis)  # type: ignore[arg-type]
    app = FastAPI()
    app.include_router(
        build_router(
            get_status=lifecycle.get_status,
            get_kis_client=lifecycle.get_kis_client,
            data_dir=tmp_path,
        )
    )
    return app


def test_past_candles_rejects_missing_code(tmp_path) -> None:
    app = _past_app(tmp_path, _FakeKisForPast())
    with TestClient(app) as c:
        r = c.get("/api/live/past-candles?from=20260501&to=20260502")
        assert r.status_code == 422


def test_past_candles_rejects_invalid_code_format(tmp_path) -> None:
    app = _past_app(tmp_path, _FakeKisForPast())
    with TestClient(app) as c:
        r = c.get("/api/live/past-candles?code=abc&from=20260501&to=20260502")
        assert r.status_code == 422


def test_past_candles_rejects_from_after_to(tmp_path) -> None:
    app = _past_app(tmp_path, _FakeKisForPast())
    with TestClient(app) as c:
        r = c.get("/api/live/past-candles?code=005930&from=20260510&to=20260501")
        assert r.status_code == 422


def test_past_candles_rejects_range_over_250_days(tmp_path) -> None:
    app = _past_app(tmp_path, _FakeKisForPast())
    with TestClient(app) as c:
        # 251 days (inclusive): 2024-01-01 to 2024-09-08
        r = c.get("/api/live/past-candles?code=005930&from=20240101&to=20240908")
        assert r.status_code == 422
        assert r.json()["detail"]["code"] == "date_range_too_large"


def test_past_candles_rejects_to_in_future(tmp_path) -> None:
    app = _past_app(tmp_path, _FakeKisForPast())
    with TestClient(app) as c:
        r = c.get(f"/api/live/past-candles?code=005930&from=20260501&to=20990101")
        assert r.status_code == 422
        assert r.json()["detail"]["code"] == "date_in_future"


@pytest.mark.asyncio
async def test_past_candles_happy_path_single_date(tmp_path) -> None:
    fake = _FakeKisForPast()
    app = _past_app(tmp_path, fake)
    with TestClient(app) as c:
        # Use a past date (yesterday relative to KST)
        kst = datetime.timezone(datetime.timedelta(hours=9))
        yesterday = (datetime.datetime.now(kst) - datetime.timedelta(days=1)).strftime("%Y%m%d")
        r = c.get(f"/api/live/past-candles?code=005930&from={yesterday}&to={yesterday}")
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["candles"] and body["candles"][0]["open"] == 100
        assert body["fresh_dates"] == [yesterday]
        assert body["cached_dates"] == []
        assert body["data_warnings"] == []
        # Disk file written under tmp_path
        assert (tmp_path / "kis-past-candles" / "005930" / f"{yesterday}.json").exists()


@pytest.mark.asyncio
async def test_past_candles_disk_cache_hit_on_second_call(tmp_path) -> None:
    fake = _FakeKisForPast()
    app = _past_app(tmp_path, fake)
    with TestClient(app) as c:
        kst = datetime.timezone(datetime.timedelta(hours=9))
        yesterday = (datetime.datetime.now(kst) - datetime.timedelta(days=1)).strftime("%Y%m%d")
        c.get(f"/api/live/past-candles?code=005930&from={yesterday}&to={yesterday}")
        assert fake.calls == [yesterday]
        # Second call — KIS should not be hit again
        r = c.get(f"/api/live/past-candles?code=005930&from={yesterday}&to={yesterday}")
        assert r.status_code == 200
        assert fake.calls == [yesterday]  # unchanged
        assert r.json()["cached_dates"] == [yesterday]
        assert r.json()["fresh_dates"] == []


@pytest.mark.asyncio
async def test_past_candles_today_memory_cache(tmp_path) -> None:
    fake = _FakeKisForPast()
    app = _past_app(tmp_path, fake)
    with TestClient(app) as c:
        kst = datetime.timezone(datetime.timedelta(hours=9))
        today = datetime.datetime.now(kst).strftime("%Y%m%d")
        c.get(f"/api/live/past-candles?code=005930&from={today}&to={today}")
        assert fake.calls == [today]
        r = c.get(f"/api/live/past-candles?code=005930&from={today}&to={today}")
        assert fake.calls == [today]  # 60s TTL not yet expired
        assert r.json()["cached_dates"] == [today]
        # No disk file written for today
        assert not (tmp_path / "kis-past-candles" / "005930" / f"{today}.json").exists()


@pytest.mark.asyncio
async def test_past_candles_partial_failure_kis_api_error(tmp_path) -> None:
    from hoga.live.kis_client import KisApiError

    class _PartialFakeKis:
        async def fetch_past_minute_candles(self, code, date_yyyymmdd):
            if date_yyyymmdd == "20260502":
                raise KisApiError(msg_cd="HTTP_500", msg1="server error")
            return [KisCandle(t_ms=1, open=100, high=110, low=95, close=105, volume=10)]

    app = _past_app(tmp_path, _PartialFakeKis())
    with TestClient(app) as c:
        r = c.get("/api/live/past-candles?code=005930&from=20260501&to=20260503")
        assert r.status_code == 200
        body = r.json()
        warnings = body["data_warnings"]
        assert len(warnings) == 1
        assert warnings[0]["date"] == "20260502"
        assert warnings[0]["reason"] == "kis_api_error"
        # Two successful dates' bars in candles_all
        assert len(body["candles"]) == 2


@pytest.mark.asyncio
async def test_past_candles_rate_limit_aborts_remaining(tmp_path) -> None:
    from hoga.live.kis_client import KisRateLimitError

    class _RateLimitedFakeKis:
        def __init__(self):
            self.calls: list[str] = []

        async def fetch_past_minute_candles(self, code, date_yyyymmdd):
            self.calls.append(date_yyyymmdd)
            if date_yyyymmdd == "20260502":
                raise KisRateLimitError("EGW00201 rate limited")
            return [KisCandle(t_ms=1, open=100, high=110, low=95, close=105, volume=10)]

    fake = _RateLimitedFakeKis()
    app = _past_app(tmp_path, fake)
    with TestClient(app) as c:
        r = c.get("/api/live/past-candles?code=005930&from=20260501&to=20260503")
        assert r.status_code == 200
        body = r.json()
        # 20260502 fires rate limit, 20260503 must be skipped
        assert fake.calls == ["20260501", "20260502"]
        reasons = [w["reason"] for w in body["data_warnings"]]
        assert "kis_rate_limit" in reasons
        assert "rate_limit_aborted" in reasons


@pytest.mark.asyncio
async def test_past_candles_weekend_empty_response(tmp_path) -> None:
    """KIS returns [] for non-trading days (weekends, holidays). Endpoint
    should accept that as a normal zero-candle date — no warning."""

    class _EmptyFakeKis:
        async def fetch_past_minute_candles(self, code, date_yyyymmdd):
            return []

    app = _past_app(tmp_path, _EmptyFakeKis())
    with TestClient(app) as c:
        # 20260516 (Saturday)
        r = c.get("/api/live/past-candles?code=005930&from=20260516&to=20260516")
        assert r.status_code == 200
        body = r.json()
        assert body["candles"] == []
        assert body["data_warnings"] == []
        assert body["fresh_dates"] == ["20260516"]


@pytest.mark.asyncio
async def test_past_candles_disk_cache_survives_router_rebuild(tmp_path) -> None:
    """Past disk cache must survive a new router/cache instance — simulating
    a server restart. Builds two apps against the same tmp_path."""
    kst = datetime.timezone(datetime.timedelta(hours=9))
    yesterday = (datetime.datetime.now(kst) - datetime.timedelta(days=1)).strftime("%Y%m%d")

    fake1 = _FakeKisForPast()
    app1 = _past_app(tmp_path, fake1)
    with TestClient(app1) as c:
        c.get(f"/api/live/past-candles?code=005930&from={yesterday}&to={yesterday}")
        assert fake1.calls == [yesterday]

    # Second router with a *fresh* cache instance (simulating restart). KIS
    # must not be called again — disk hit only.
    fake2 = _FakeKisForPast()
    app2 = _past_app(tmp_path, fake2)
    with TestClient(app2) as c:
        r = c.get(f"/api/live/past-candles?code=005930&from={yesterday}&to={yesterday}")
        assert r.status_code == 200
        assert fake2.calls == []
        assert r.json()["cached_dates"] == [yesterday]


# ----- /api/live/past-daily-candles validation -----

from hoga.live.api import _validate_daily_past_request
from fastapi import HTTPException


def test_validate_daily_accepts_uncapped_range() -> None:
    today = _today_kst_yyyymmdd()
    frm, too, today_d = _validate_daily_past_request("005930", "20060101", today)
    assert frm.strftime("%Y%m%d") == "20060101"


def test_validate_daily_rejects_invalid_code() -> None:
    with pytest.raises(HTTPException) as exc:
        _validate_daily_past_request("abc", "20240101", "20240102")
    assert exc.value.status_code == 422


def test_validate_daily_rejects_invalid_date() -> None:
    with pytest.raises(HTTPException) as exc:
        _validate_daily_past_request("005930", "2024-01-01", "20240102")
    assert exc.value.status_code == 422


def test_validate_daily_rejects_from_after_to() -> None:
    with pytest.raises(HTTPException) as exc:
        _validate_daily_past_request("005930", "20240505", "20240101")
    assert exc.value.status_code == 422


def test_validate_daily_rejects_future_to() -> None:
    today = _today_kst_yyyymmdd()
    from datetime import timedelta as _td, datetime as _dt
    kst = datetime.timezone(datetime.timedelta(hours=9))
    tomorrow = (_dt.now(kst) + _td(days=1)).strftime("%Y%m%d")
    with pytest.raises(HTTPException) as exc:
        _validate_daily_past_request("005930", today, tomorrow)
    assert exc.value.status_code == 422
