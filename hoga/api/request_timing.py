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


def _log_timing(
    *,
    scope,
    status: int,
    ttfb_ms: float,
    duration_ms: float,
    body_bytes: int | None,
    streaming: bool,
) -> None:
    threshold = slow_request_threshold_ms()
    observed_ms = ttfb_ms if streaming else duration_ms
    slow = threshold > 0 and observed_ms >= threshold
    if not (slow or perf_debug.enabled()):
        return

    query = scope.get("query_string", b"").decode("latin-1")
    query = query[:_QUERY_LOG_MAX_CHARS]
    body_bytes_field = "" if body_bytes is None else f" body_bytes={body_bytes}"
    streaming_field = " streaming=1" if streaming else ""
    log.warning(
        "hoga_perf http_request status=%d method=%s path=%s%s%s "
        "ttfb_ms=%.1f duration_ms=%.1f%s%s%s",
        status,
        scope.get("method", "-"),
        scope.get("path", "-"),
        "?" if query else "",
        query,
        ttfb_ms,
        duration_ms,
        body_bytes_field,
        streaming_field,
        " slow=1" if slow else "",
    )


class RequestTimingMiddleware:
    """최외곽 ASGI 래퍼 — scope type이 http가 아니면(ws, lifespan) 통과."""

    def __init__(self, app) -> None:
        self.app = app

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        t0 = time.perf_counter()
        status = 0
        ttfb_ms: float | None = None
        body_bytes = 0
        streaming = False
        logged = False

        async def send_wrapper(message) -> None:
            nonlocal status, ttfb_ms, body_bytes, streaming, logged
            if message["type"] == "http.response.start":
                status = int(message["status"])
                ttfb_ms = (time.perf_counter() - t0) * 1000
                headers = {
                    key.lower(): value.lower()
                    for key, value in message.get("headers", [])
                }
                content_type = headers.get(b"content-type", b"")
                streaming = content_type.startswith(b"text/event-stream")
                if streaming:
                    _log_timing(
                        scope=scope,
                        status=status,
                        ttfb_ms=ttfb_ms,
                        duration_ms=ttfb_ms,
                        body_bytes=None,
                        streaming=True,
                    )
                    logged = True
            await send(message)
            if message["type"] == "http.response.body":
                body_bytes += len(message.get("body", b""))
                if not message.get("more_body", False) and not logged:
                    duration_ms = (time.perf_counter() - t0) * 1000
                    _log_timing(
                        scope=scope,
                        status=status,
                        ttfb_ms=ttfb_ms or duration_ms,
                        duration_ms=duration_ms,
                        body_bytes=body_bytes,
                        streaming=False,
                    )
                    logged = True

        await self.app(scope, receive, send_wrapper)
