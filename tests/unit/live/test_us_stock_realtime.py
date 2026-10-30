import asyncio
import gzip
import json
from datetime import datetime
from pathlib import Path

import pytest

from hoga.live.us_stock_realtime import UsStockRealtime, parse_observation


def real_rows():
    root = Path(__file__).parents[3]
    data = json.loads(gzip.decompress((root / "docs/research/2026-10-24-us-stock-realtime-live.json.gz").read_bytes()))
    return [r for name, stream in data["ws"].items() if name.startswith("us") for r in stream["records"]]


def incoming(row):
    return {"type": "FE", "stexTp": row["exchange"], "item": row["item"], "values": row["values"]}


def stamp(row):
    return int(datetime.fromisoformat(row["received_at_utc"]).timestamp() * 1000)


def test_all_real_records_parse_signed_prices_and_minute_labels():
    rows = real_rows()
    assert len(rows) == 1387
    for row in rows:
        parsed = parse_observation(incoming(row), stamp(row))
        assert parsed is not None
        key, day, minute = parsed
        assert key[1] == row["item"]
        assert 0 < day.low <= day.close <= day.high
        assert minute % 60_000 == 0


@pytest.mark.parametrize("field,value", [("290", "4"), ("22", "20260230"), ("51020", "261000"),
                                         ("10", "NaN"), ("10", "0"), ("17", "1"), ("16", "")])
def test_invalid_or_unverified_session_observations_are_rejected(field, value):
    row = real_rows()[0]
    message = incoming(row)
    message["values"] = {**message["values"], field: value}
    assert parse_observation(message, stamp(row)) is None


def test_same_minute_prices_preserve_extremes_before_broadcast():
    rows = [r for r in real_rows() if r["item"] == "NVDA"]
    now = [stamp(rows[0])]
    stream = UsStockRealtime(lambda _: None, token_fn=None, now_fn=lambda: now[0])
    stream.subjects = frozenset({("NASDAQ", "NVDA")})
    for row in rows:
        now[0] = stamp(row)
        stream.ingest(incoming(row))
    event = stream.event(("NASDAQ", "NVDA"), seed=True)
    assert event["sequence"] == len(rows)
    first = event["minutes"][0]
    assert first["high"] == 212.3799 and first["low"] == 212.16
    assert event["daily"]["open"] == 210.94
    assert all(b["volume"] == 0 for b in event["minutes"])


def test_old_day_and_other_instrument_do_not_pollute_aggregate():
    row = real_rows()[0]
    stream = UsStockRealtime(lambda _: None, token_fn=None, now_fn=lambda: stamp(row) + 86400_000)
    stream.subjects = frozenset({("NASDAQ", "AAPL")})
    stream.ingest(incoming(row))
    assert not stream.minutes and not stream.daily


async def test_current_day_cache_singleflight_and_never_promotes_coverage(monkeypatch):
    from hoga.live.us_daily_candles import UsFetchResult
    from hoga.live.us_stock_current_day import UsStockCurrentDay

    source = real_rows()[0]
    day = parse_observation(incoming(source), stamp(source))[1]
    calls = []

    async def fetch(*args, **kwargs):
        calls.append((args, kwargs))
        return UsFetchResult(bars=[day])

    monkeypatch.setattr("hoga.live.us_stock_current_day.fetch_stock_daily", fetch)
    service = UsStockCurrentDay(clock=lambda: 0)
    bars = await asyncio.gather(*(service.get(object(), None, "NYSE", "KO", day.trading_date) for _ in range(5)))
    assert all(bar == day for bar in bars) and len(calls) == 1
    assert calls[0][1] == {"max_pages": 1, "adjusted_as_of": day.trading_date}
    await service.aclose()


async def test_production_ws_transport_uses_us_registration_and_publishes_aggregated_frames():
    row = real_rows()[0]
    accepted = asyncio.Event()
    sent, published = [], []
    key = ("NYSE", "KO")

    class Socket:
        def __init__(self):
            self.replies = [json.dumps({"trnm": "LOGIN", "return_code": 0}),
                            json.dumps({"trnm": "REG", "return_code": 0}),
                            json.dumps({"trnm": "REAL", "data": [incoming(row)]})]

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            pass

        async def send(self, data):
            sent.append(json.loads(data))

        async def recv(self):
            if self.replies:
                return self.replies.pop(0)
            accepted.set()
            await asyncio.Event().wait()

    async def token(account):
        assert account == 5
        return "test-token-never-published"

    def connect(url, **kwargs):
        assert url.endswith("/api/us/websocket")
        return Socket()

    stream = UsStockRealtime(published.append, token_fn=token, now_fn=lambda: stamp(row), connect=connect)
    await stream.configure(5, {key})
    await asyncio.wait_for(accepted.wait(), 2)
    event = stream.event(key)
    assert event["daily"]["close"] == abs(float(row["values"]["10"]))
    assert event["status"] == "streaming"
    assert sent[1]["data"] == [{"item": [{"jmcode": "KO", "stex_tp": "NY"}], "type": ["FE"]}]
    assert "test-token-never-published" not in json.dumps(published)
    await stream.stop()


async def test_token_failure_is_redacted_and_keeps_reconnect_task_alive():
    from hoga.live.kiwoom_token_provider import KiwoomAuthTransient

    failed = asyncio.Event()
    events = []

    class Socket:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            pass

        async def send(self, raw):
            pytest.fail("authentication failed before any LOGIN can be sent")

    async def token(_):
        raise KiwoomAuthTransient("sensitive diagnostic must not be published")

    def publish(event):
        events.append(event)
        if event["status"] == "error":
            failed.set()

    stream = UsStockRealtime(publish, token_fn=token, connect=lambda *a, **kw: Socket())
    await stream.configure(5, {("NASDAQ", "AAPL")})
    await asyncio.wait_for(failed.wait(), 2)
    assert not stream.task.done()
    assert "sensitive diagnostic" not in json.dumps(events)
    await stream.stop()


@pytest.mark.parametrize("reply", [[], {"trnm": "LOGIN", "return_code": 1}])
async def test_login_rejects_invalid_envelopes_and_invalidates_only_vendor_rejection(reply):
    invalidated, sent = [], []

    class Socket:
        replies = [json.dumps({"trnm": "PING"}), json.dumps(reply)]

        async def send(self, data):
            sent.append(json.loads(data))

        async def recv(self):
            return self.replies.pop(0)

    async def token(_):
        return "test-token"

    async def invalidate(account):
        invalidated.append(account)

    stream = UsStockRealtime(lambda _: None, token_fn=token, invalidate_fn=invalidate)
    stream.account = 5
    with pytest.raises((ValueError, ConnectionError)):
        await stream.login(Socket())
    assert sent[-1] == {"trnm": "PING"}
    assert invalidated == ([5] if isinstance(reply, dict) else [])


def test_http_daily_includes_provisional_baseline_but_historical_request_does_not(monkeypatch, tmp_path):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from hoga.live.us_daily_candles import NY, UsDailyMetadata
    from hoga.live.us_market_api import UsMarketApi

    api = UsMarketApi(tmp_path)
    api.daily.calendar_now = lambda: datetime(2026, 10, 23, 11, 25, tzinfo=NY)
    calls = []

    async def history(*args, **kwargs):
        return [], UsDailyMetadata(source="kiwoom", price_basis="raw", currency="USD", session_scope="unverified")

    async def current(*args):
        calls.append(args)
        row = real_rows()[0]
        return parse_observation(incoming(row), stamp(row))[1]

    api.daily.get = history
    api.stock_current_day.get = current
    monkeypatch.setattr("hoga.live.us_market_api.kiwoom_rest_runtime.ensure_rest_client", lambda _: object())
    monkeypatch.setattr("hoga.live.us_market_api.kiwoom_rest_runtime.ensure_scheduler", lambda _: object())
    app = FastAPI()
    app.include_router(api.router, prefix="/api/live")
    with TestClient(app) as client:
        response = client.get("/api/live/us-stock-daily-candles?exchange=NYSE&symbol=KO&from=20261022&to=20261023")
        assert response.status_code == 200
        data = response.json()
        assert data["candles"][0]["trading_date"] == "20261023"
        assert data["daily_metadata"]["completed"] == []
        assert len(calls) == 1
        response = client.get("/api/live/us-stock-daily-candles?exchange=NYSE&symbol=KO&from=20261022&to=20261022")
        assert response.status_code == 200 and not response.json()["candles"]
        assert len(calls) == 1
