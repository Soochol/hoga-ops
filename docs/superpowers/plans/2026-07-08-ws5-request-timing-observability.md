# WS5: 요청 타이밍 관측 seam Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 모든 HTTP 요청의 TTFB(첫 응답 바이트까지) 지연을 측정해, 느린 요청은 항상 로그하고 `HOGA_PERF_DEBUG` 시 전 요청을 로그하는 관측 seam을 추가한다.

**Architecture:** 순수 ASGI 미들웨어 1개(`hoga/api/request_timing.py`)를 `create_app`에 최외곽으로 배선. `BaseHTTPMiddleware`가 아닌 raw ASGI로 구현해 SSE/스트리밍 응답에서 스트림 수명이 아니라 응답 시작 시점(`http.response.start`)을 측정한다. 기존 `hoga_perf <name> key=value duration_ms=%.1f` + `log.warning` 관례를 그대로 따른다. 2단 정책: (1) `HOGA_SLOW_REQUEST_MS`(기본 2000, `0`=비활성) 초과 요청은 **항상** 로그, (2) `HOGA_PERF_DEBUG` 활성 시 전 요청 로그. 이 미들웨어가 느린 엔드포인트를 상시 노출하면, 세부 분해는 기존 `HOGA_PERF_DEBUG` 계층(api_range / range_date / past_candles_*)이 담당하는 2-tier 구조.

**Tech Stack:** FastAPI/Starlette ASGI, pytest + TestClient + caplog. 테스트 실행은 `uv run --extra dev pytest`.

**의도적 제외 (YAGNI):** 성능 회귀 SLA 테스트(로컬 단일유저 환경에서 flaky), DuckDB 쿼리-플랜 로깅, 구조화(JSON) 로깅. 요청-레벨 상시 slow-log가 우선 seam이다.

---

### Task 1: RequestTimingMiddleware 모듈 + 단위 테스트

**Files:**
- Create: `hoga/api/request_timing.py`
- Test: `tests/unit/api/test_request_timing.py`

- [ ] **Step 1: 실패하는 테스트 작성**

`tests/unit/api/test_request_timing.py`:

```python
"""WS5 요청 타이밍 미들웨어 — TTFB 측정 + slow/debug 2단 로그 정책."""

from __future__ import annotations

import asyncio
import logging

import pytest
from fastapi import FastAPI
from fastapi.responses import StreamingResponse
from fastapi.testclient import TestClient

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

        return StreamingResponse(_gen())

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
    assert "slow=1" not in record.getMessage()


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

    본문 生成 중 50ms sleep이 있어도 duration은 응답 시작까지만 측정 —
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
    duration = float(record.getMessage().rsplit("duration_ms=", 1)[1].split()[0])
    assert duration < 30.0


def test_invalid_threshold_falls_back_to_default(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from hoga.api import request_timing

    monkeypatch.setenv("HOGA_SLOW_REQUEST_MS", "abc")
    assert request_timing.slow_request_threshold_ms() == (
        request_timing.DEFAULT_SLOW_REQUEST_MS
    )
```

- [ ] **Step 2: 테스트가 실패하는지 확인**

Run: `uv run --extra dev pytest tests/unit/api/test_request_timing.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'hoga.api.request_timing'`

- [ ] **Step 3: 최소 구현 작성**

`hoga/api/request_timing.py`:

```python
"""요청 단위 타이밍 관측 seam (WS5).

순수 ASGI 미들웨어로 HTTP 요청의 TTFB(http.response.start까지)를 측정한다.
BaseHTTPMiddleware를 쓰지 않는 이유: SSE/스트리밍 응답에서 스트림 전체
수명이 아니라 응답 시작 시점을 측정해야 slow-log가 스트림 지속시간으로
오염되지 않는다.

2단 정책:
- HOGA_SLOW_REQUEST_MS(기본 2000ms, "0"=비활성) 초과 요청은 항상 로그.
- HOGA_PERF_DEBUG 활성 시 전 요청 로그 (기존 hoga_perf 관례와 동일 게이트).

로그 포맷은 기존 관례(hoga_perf <name> key=value duration_ms=%.1f,
log.warning)를 따른다 — routes.py의 api_range 로그와 같은 grep 표면.
"""

from __future__ import annotations

import logging
import os
import time

from hoga import perf_debug

log = logging.getLogger(__name__)

DEFAULT_SLOW_REQUEST_MS = 2000.0
_QUERY_LOG_MAX_CHARS = 200


def slow_request_threshold_ms() -> float:
    raw = os.environ.get("HOGA_SLOW_REQUEST_MS", "")
    if not raw:
        return DEFAULT_SLOW_REQUEST_MS
    try:
        return float(raw)
    except ValueError:
        return DEFAULT_SLOW_REQUEST_MS


class RequestTimingMiddleware:
    """최외곽 ASGI 래퍼 — scope type이 http가 아니면(ws, lifespan) 통과."""

    def __init__(self, app) -> None:
        self.app = app

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        t0 = time.perf_counter()

        async def send_wrapper(message) -> None:
            if message["type"] == "http.response.start":
                duration_ms = (time.perf_counter() - t0) * 1000
                threshold = slow_request_threshold_ms()
                slow = threshold > 0 and duration_ms >= threshold
                if slow or perf_debug.enabled():
                    query = scope.get("query_string", b"").decode("latin-1")
                    query = query[:_QUERY_LOG_MAX_CHARS]
                    log.warning(
                        "hoga_perf http_request status=%d method=%s path=%s%s%s "
                        "duration_ms=%.1f%s",
                        message["status"],
                        scope.get("method", "-"),
                        scope.get("path", "-"),
                        "?" if query else "",
                        query,
                        duration_ms,
                        " slow=1" if slow else "",
                    )
            await send(message)

        await self.app(scope, receive, send_wrapper)
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `uv run --extra dev pytest tests/unit/api/test_request_timing.py -v`
Expected: 6 PASS

- [ ] **Step 5: 커밋**

```bash
git add hoga/api/request_timing.py tests/unit/api/test_request_timing.py
git commit -m "feat(api): 요청 TTFB 타이밍 미들웨어 — slow-log 상시 + HOGA_PERF_DEBUG 전수 로그 (WS5)"
```

---

### Task 2: create_app 배선 + 배선 테스트

**Files:**
- Modify: `hoga/api/app.py` (import 블록 + `app.add_middleware(CORSMiddleware, ...)` 직후)
- Test: `tests/unit/api/test_request_timing.py` (테스트 1개 추가)

- [ ] **Step 1: 실패하는 배선 테스트 추가**

`tests/unit/api/test_request_timing.py` 끝에 추가:

```python
def test_create_app_wires_timing_middleware(tmp_path) -> None:
    from hoga.api.app import create_app

    app = create_app(tmp_path)
    assert any(m.cls is RequestTimingMiddleware for m in app.user_middleware)
```

- [ ] **Step 2: 실패 확인**

Run: `uv run --extra dev pytest tests/unit/api/test_request_timing.py::test_create_app_wires_timing_middleware -v`
Expected: FAIL — `assert any(...)` False

- [ ] **Step 3: app.py 배선**

`hoga/api/app.py` import 블록에 추가 (`from hoga.api.queries import QueryEngine` 부근):

```python
from hoga.api.request_timing import RequestTimingMiddleware
```

CORS 미들웨어 등록 블록(`app.add_middleware(CORSMiddleware, ...)`) **바로 뒤**에 추가 — Starlette는 나중에 추가된 미들웨어가 최외곽이므로 타이밍이 CORS 처리까지 포함해 측정된다:

```python
    # WS5: 요청 TTFB 타이밍 — 마지막에 추가해 최외곽(전 구간 측정)으로 배선.
    app.add_middleware(RequestTimingMiddleware)
```

- [ ] **Step 4: 전체 테스트 통과 확인**

Run: `uv run --extra dev pytest tests/unit/api/test_request_timing.py -v`
Expected: 7 PASS

- [ ] **Step 5: 인접 회귀 확인 (app 팩토리 사용 테스트)**

Run: `uv run --extra dev pytest tests/test_api.py tests/test_api_range.py -q`
Expected: 기존과 동일 (test_api_range의 사전 실패 14건 외 신규 실패 없음 — 사전 실패는 ADR-0085 기록 참조)

- [ ] **Step 6: 커밋**

```bash
git add hoga/api/app.py tests/unit/api/test_request_timing.py
git commit -m "feat(api): create_app에 RequestTimingMiddleware 최외곽 배선 (WS5)"
```
