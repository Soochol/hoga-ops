"""start_live_stream / stop_live_stream / _compute_live_set integration.

Task 13: poller 시절 테스트(start/refresh_live_poller 등)는 함수와 함께 은퇴.
가드 의미론(creds/빈 watchlist/symbol 필터/cold cache/stop 멱등)은 stream
경로로 포팅해 커버리지를 승계한다. refresh 경로는 test_lifecycle.py의
Task 11 테스트가 커버.
"""
import json
from pathlib import Path
from types import SimpleNamespace

import pytest


def _write_watchlist(tmp_path: Path, codes: list[str]) -> None:
    (tmp_path / "watchlist.json").write_text(json.dumps({
        "version": 1,
        "entries": [
            {"code": c, "name": c,
             "registered_at_kst_date": "20260101", "last_success_date": None}
            for c in codes
        ],
    }))


@pytest.mark.asyncio
async def test_start_live_stream_returns_falsy_when_creds_missing(
    tmp_path: Path, monkeypatch,
) -> None:
    """Without KIS_APP_KEY/SECRET, stream stays off (poller 가드 승계)."""
    from hoga.live import lifecycle

    lifecycle.reset_for_tests()
    monkeypatch.delenv("KIS_APP_KEY", raising=False)
    monkeypatch.delenv("KIS_APP_SECRET", raising=False)
    _write_watchlist(tmp_path, ["005930"])
    assert not await lifecycle.start_live_stream(data_dir=tmp_path)
    assert lifecycle.get_status().running is False


@pytest.mark.asyncio
async def test_start_live_stream_returns_falsy_when_watchlist_empty(
    tmp_path: Path, monkeypatch,
) -> None:
    from hoga.live import lifecycle

    lifecycle.reset_for_tests()
    monkeypatch.setenv("KIS_APP_KEY", "K")
    monkeypatch.setenv("KIS_APP_SECRET", "S")
    _write_watchlist(tmp_path, [])
    assert not await lifecycle.start_live_stream(data_dir=tmp_path)
    assert lifecycle.get_status().running is False


@pytest.mark.asyncio
async def test_stop_live_stream_is_idempotent(tmp_path: Path) -> None:
    from hoga.live import lifecycle

    lifecycle.reset_for_tests()
    await lifecycle.stop_live_stream()
    await lifecycle.stop_live_stream()   # 두 번째 호출도 무해
    assert lifecycle.get_status().running is False


def test_compute_live_set_filters_unknown_codes(tmp_path: Path, monkeypatch, caplog) -> None:
    """symbol-master에 없는 코드는 drop + 경고 로그 — poller 필터 정책 승계."""
    import logging

    from hoga.api import symbols
    from hoga.live import lifecycle

    _write_watchlist(tmp_path, ["005930", "999999"])
    monkeypatch.setattr(
        symbols, "search",
        lambda q, limit=10_000: [SimpleNamespace(code="005930")],
    )
    with caplog.at_level(logging.WARNING):
        assert lifecycle._compute_live_set(tmp_path) == ["005930"]
    assert any("codes_unknown" in r.message for r in caplog.records)  # I2 pin


def test_compute_live_set_cold_cache_keeps_all(tmp_path: Path, monkeypatch) -> None:
    """symbol-master cold cache(빈 결과)면 무필터 폴백 — 캡처 중단보다 노이즈 선호."""
    from hoga.api import symbols
    from hoga.live import lifecycle

    _write_watchlist(tmp_path, ["005930", "999999"])
    monkeypatch.setattr(symbols, "search", lambda q, limit=10_000: [])
    assert lifecycle._compute_live_set(tmp_path) == ["005930", "999999"]


@pytest.mark.asyncio
async def test_lifespan_starts_and_stops_stream_gracefully(tmp_path: Path, monkeypatch) -> None:
    """The FastAPI lifespan integrates start_live_stream + stop_live_stream.

    Task 11: lifespan was switched from poller to stream path.  The WS gate
    (ws_capture_window) is deterministically forced closed so KisWsClient.run
    sleeps instead of attempting a real approval-key fetch — the test is
    therefore safe to run at any day/time without network access.
    """
    import json
    from fastapi.testclient import TestClient

    from hoga.api.app import create_app
    from hoga.live import lifecycle, session_gate

    # Force the WS gate closed: ws_capture_window → should_run_now → False.
    # This makes KisWsClient.run sleep(30) in its gate loop instead of calling
    # kis.get_approval_key(), keeping the test network-free regardless of wall
    # clock (the gate is nondeterministic on a weekday trading-hours grader run).
    monkeypatch.setattr(session_gate, "should_run_now", lambda _t: False)

    lifecycle.reset_for_tests()
    monkeypatch.setenv("KIS_APP_KEY", "K")
    monkeypatch.setenv("KIS_APP_SECRET", "S")
    (tmp_path / "watchlist.json").write_text(json.dumps({
        "version": 1,
        "entries": [
            {"code": "005930", "name": "삼성전자",
             "registered_at_kst_date": "20260101", "last_success_date": None},
        ],
    }))

    app = create_app(tmp_path)
    with TestClient(app) as c:
        r = c.get("/api/live/status")
        assert r.status_code == 200
        # With creds + watchlist, stream should be running (tasks spawned)
        assert r.json()["running"] is True
        assert r.json()["watchlist_count"] == 1

    # After TestClient exits, lifespan finally ran — stream should be stopped
    assert lifecycle.get_status().running is False
