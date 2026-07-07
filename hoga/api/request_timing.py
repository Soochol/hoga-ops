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
