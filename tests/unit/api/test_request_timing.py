"""WS5 요청 타이밍 미들웨어 — TTFB 측정 + slow/debug 2단 로그 정책."""

from __future__ import annotations

import asyncio
import logging

import pytest
from fastapi import FastAPI
from fastapi.responses import StreamingResponse
from fastapi.testclient import TestClient

from hoga.api import request_timing
from hoga.api.app import create_app
from hoga.api.request_timing import RequestTimingMiddleware

LOGGER_NAME = "hoga.api.request_timing"


def _make_client(sleep_s: float = 0.0) -> TestClient:
    app = FastAPI()

    @app.get("/ping")
    async def _ping() -> dict[str, str]:
        if sleep_s:
            await asyncio.sleep(sleep_s)
        return {"pong": "1"}

    @app.get("/stream")
    async def _stream() -> StreamingResponse:
        async def _gen():
            yield b"first"
            await asyncio.sleep(0.05)
            yield b"rest"

        return StreamingResponse(_gen(), media_type="text/event-stream")

    app.add_middleware(RequestTimingMiddleware)
    return TestClient(app)


def _timing_records(caplog: pytest.LogCaptureFixture) -> list[logging.LogRecord]:
    return [r for r in caplog.records if r.name == LOGGER_NAME]


def test_fast_request_not_logged_by_default(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    monkeypatch.delenv("HOGA_PERF_DEBUG", raising=False)
    monkeypatch.delenv("HOGA_SLOW_REQUEST_MS", raising=False)
    client = _make_client()
    with caplog.at_level(logging.INFO, logger=LOGGER_NAME):
        resp = client.get("/ping")
    assert resp.status_code == 200
    assert _timing_records(caplog) == []


def test_slow_request_always_logged(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    monkeypatch.delenv("HOGA_PERF_DEBUG", raising=False)
    monkeypatch.setenv("HOGA_SLOW_REQUEST_MS", "1")
    client = _make_client(sleep_s=0.02)
    with caplog.at_level(logging.INFO, logger=LOGGER_NAME):
        resp = client.get("/ping?code=005930")
    assert resp.status_code == 200
    [record] = _timing_records(caplog)
    msg = record.getMessage()
    assert "hoga_perf http_request" in msg
    assert "status=200" in msg
    assert "path=/ping" in msg
    assert "code=005930" in msg  # 쿼리스트링 포함
    assert "slow=1" in msg


def test_perf_debug_logs_every_request(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    monkeypatch.setenv("HOGA_PERF_DEBUG", "1")
    monkeypatch.delenv("HOGA_SLOW_REQUEST_MS", raising=False)
    client = _make_client()
    with caplog.at_level(logging.INFO, logger=LOGGER_NAME):
        resp = client.get("/ping")
    assert resp.status_code == 200
    [record] = _timing_records(caplog)
    msg = record.getMessage()
    assert "slow=1" not in msg
    assert "ttfb_ms=" in msg
    assert "duration_ms=" in msg
    assert "body_bytes=" in msg
    assert "streaming=1" not in msg


def test_regular_response_logs_once_at_final_body(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    monkeypatch.setenv("HOGA_PERF_DEBUG", "1")
    client = _make_client()
    with caplog.at_level(logging.INFO, logger=LOGGER_NAME):
        response = client.get("/ping")
    [record] = _timing_records(caplog)
    assert f"body_bytes={len(response.content)}" in record.getMessage()


def test_zero_threshold_disables_slow_log(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    monkeypatch.delenv("HOGA_PERF_DEBUG", raising=False)
    monkeypatch.setenv("HOGA_SLOW_REQUEST_MS", "0")
    client = _make_client(sleep_s=0.02)
    with caplog.at_level(logging.INFO, logger=LOGGER_NAME):
        client.get("/ping")
    assert _timing_records(caplog) == []


def test_streaming_measures_ttfb_not_stream_lifetime(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """SSE류 스트리밍: 응답 시작(http.response.start) 시점에 1회 로그.

    본문 생성 중 50ms sleep이 있어도 duration은 응답 시작까지만 측정 —
    threshold 30ms에 걸리지 않아야 TTFB 측정임이 증명된다.
    """
    monkeypatch.setenv("HOGA_PERF_DEBUG", "1")
    monkeypatch.delenv("HOGA_SLOW_REQUEST_MS", raising=False)
    client = _make_client()
    with caplog.at_level(logging.INFO, logger=LOGGER_NAME):
        resp = client.get("/stream")
    assert resp.status_code == 200
    assert resp.content == b"firstrest"
    [record] = _timing_records(caplog)
    msg = record.getMessage()
    duration = float(msg.rsplit("duration_ms=", 1)[1].split()[0])
    assert duration < 30.0
    assert "streaming=1" in msg
    assert "body_bytes=" not in msg


def test_invalid_threshold_falls_back_to_default(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("HOGA_SLOW_REQUEST_MS", "abc")
    assert request_timing.slow_request_threshold_ms() == (
        request_timing.DEFAULT_SLOW_REQUEST_MS
    )


def test_create_app_wires_timing_middleware(tmp_path) -> None:
    app = create_app(tmp_path)
    assert any(m.cls is RequestTimingMiddleware for m in app.user_middleware)
