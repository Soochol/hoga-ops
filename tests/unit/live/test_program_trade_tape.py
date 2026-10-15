import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from hoga.live import program_trade_latch as latch
from hoga.live.program_trade_collector import ProgramTradeCollector
from hoga.live.program_trade_tape import ProgramTradeTapeStore
from hoga.live.program_trade_tape_api import build_router
from hoga.util.timeenc import hhmmssms_to_unix_ms

T = hhmmssms_to_unix_ms("20261015", 100000000)


def row(i, **extra):
    return {"event_id": f"id-{i:05}", "t_ms": T, "price": 125500, "event_delta_qty": i + 1, **extra}


def test_pages_preserve_equal_time_events_and_stable_cursor_during_append(tmp_path):
    store = ProgramTradeTapeStore(tmp_path)
    store.append([("005930", "KRX", row(i)) for i in range(7)])
    first, before = store.page("005930", "KRX", "20261015", before=None, limit=3)
    assert [r["event_delta_qty"] for r in first] == [7, 6, 5]
    store.append([("005930", "KRX", row(7))])
    second, before2 = store.page("005930", "KRX", "20261015", before=before, limit=3)
    assert [r["event_delta_qty"] for r in second] == [4, 3, 2]
    last, end = store.page("005930", "KRX", "20261015", before=before2, limit=3)
    assert [r["event_delta_qty"] for r in last] == [1]
    assert end is None


def test_reader_survives_restart_duplicate_retry_torn_line_and_chunk_boundaries(tmp_path):
    store = ProgramTradeTapeStore(tmp_path)
    events = [("005930", "KRX", row(i)) for i in range(1000)]
    store.append(events)
    store.append(events[-5:])
    path = store.path("005930", "KRX", "20261015")
    with path.open("ab") as stream:
        stream.write(b'{"event_id":"torn')
    store.append([("005930", "KRX", row(1000))])
    restarted = ProgramTradeTapeStore(tmp_path)
    rows, cursor = [], None
    while True:
        page, cursor = restarted.page("005930", "KRX", "20261015", before=cursor, limit=200)
        rows += page
        if cursor is None:
            break
    assert {r["event_id"] for r in rows} == {f"id-{i:05}" for i in range(1001)}
    assert rows[0]["event_delta_qty"] == 1001


def test_routes_validate_scope_and_serialize_signed_nullable_events(tmp_path):
    store = ProgramTradeTapeStore(tmp_path)
    store.append([("005930", "KRX", row(0, event_delta_qty=-300, price=None)),
                  ("005930", "NXT", row(1)), ("000660", "KRX", row(2)),
                  ("005930", "KRX", row(3, t_ms=T - 86400000))])
    app = FastAPI()
    app.include_router(build_router(data_dir=tmp_path))
    with TestClient(app) as client:
        url = "/api/live/program-trades?code=005930&date=20261015&venue=KRX"
        body = client.get(url).json()
        assert body == {"code": "005930", "date": "20261015", "venue": "KRX",
                        "rows": [row(0, event_delta_qty=-300, price=None)], "next_before": None}
        assert client.get(url.replace("KRX", "NXT")).json()["rows"] == [row(1)]
        assert client.get(url.replace("20261015", "20261016")).json()["rows"] == []
        for suffix in ("&before=-1", "&limit=0", "&limit=501"):
            assert client.get(url + suffix).status_code == 422
        assert client.get(url.replace("20261015", "20260230")).status_code == 422
        assert client.get(url.replace("KRX", "BAD")).status_code == 422


@pytest.mark.asyncio
async def test_every_accepted_event_persists_even_after_gate_closes_and_on_retry(tmp_path, monkeypatch):
    latch.reset_for_tests()
    async def closed(_stamp):
        return frozenset()
    collector = ProgramTradeCollector(data_dir=tmp_path, date_fn=lambda: "20261015",
                                      now_ms_fn=lambda: T, open_venues_fn=closed)
    ids = []
    for _ in range(3):
        payload = latch.update("005930", {"t_ms": T, "price": 125500, "event_delta_qty": 10}, venue="KRX", record=True)
        ids.append(payload["event_id"])
    assert len(set(ids)) == 3  # equal-time identical amounts are distinct reports
    original = collector.tape.append
    attempts = 0
    def fail_once(events):
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise OSError("disk unavailable")
        original(events)
    monkeypatch.setattr(collector.tape, "append", fail_once)
    await collector.run_once()
    assert collector.status.last_error is not None
    await collector.run_once()
    rows, _ = collector.tape.page("005930", "KRX", "20261015", before=None, limit=200)
    assert [r["event_id"] for r in rows] == ids[::-1]
    latch.reset_for_tests()


def test_queue_never_records_zero_missing_or_closed_events_and_is_bounded(monkeypatch):
    latch.reset_for_tests()
    monkeypatch.setattr(latch, "MAX_PENDING_EVENTS", 2)
    for qty in (0, None):
        latch.update("005930", {"t_ms": T, "event_delta_qty": qty}, venue="KRX", record=True)
    latch.update("005930", {"t_ms": T, "event_delta_qty": 5}, venue="KRX", record=False)
    assert latch.take_events() == []
    for _ in range(3):
        latch.update("005930", {"t_ms": T, "event_delta_qty": 5}, venue="KRX", record=True)
    assert latch.event_queue_overflow
    first = latch.take_events()
    assert len(first) == 2
    for _ in range(2):
        latch.update("005930", {"t_ms": T, "event_delta_qty": 5}, venue="KRX", record=True)
    latch.retry_events(first)
    assert latch.take_events() == first
    latch.reset_for_tests()
