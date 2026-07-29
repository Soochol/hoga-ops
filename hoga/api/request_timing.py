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
# 이 값 이상은 서버 결함으로 보고 두 성능 게이트와 무관하게 항상 로그한다.
# 4xx 는 호출자 잘못이라 제외 — 404 를 훑는 브라우저 한 대가 5xx 신호를 덮는다.
_SERVER_ERROR_STATUS = 500


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
    # Server errors are always logged, regardless of the two perf gates. A 500
    # that returns quickly (the common case — a raise on the way in) matched
    # neither `slow` nor `perf_debug.enabled()`, so the only record of it was
    # uvicorn's stderr line. This is the one place that sees method+path+status
    # for every request, which makes it the cheapest correlation surface we
    # have; the route-level handler still owns the traceback.
    server_error = status >= _SERVER_ERROR_STATUS
    if not (slow or server_error or perf_debug.enabled()):
        return

    query = scope.get("query_string", b"").decode("latin-1")
    query = query[:_QUERY_LOG_MAX_CHARS]
    body_bytes_field = "" if body_bytes is None else f" body_bytes={body_bytes}"
    streaming_field = " streaming=1" if streaming else ""
    log.warning(
        "hoga_perf http_request status=%d method=%s path=%s%s%s "
        "ttfb_ms=%.1f duration_ms=%.1f%s%s%s%s",
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
        # Distinct token so `grep server_error=1` finds every 5xx without also
        # matching the status= field of unrelated lines.
        " server_error=1" if server_error else "",
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
                        ttfb_ms=ttfb_ms if ttfb_ms is not None else duration_ms,
                        duration_ms=duration_ms,
                        body_bytes=body_bytes,
                        streaming=False,
                    )
                    logged = True

        try:
            await self.app(scope, receive, send_wrapper)
        except Exception:
            # Starlette builds the stack as
            #   ServerErrorMiddleware -> user middleware -> ExceptionMiddleware -> router
            # so ServerErrorMiddleware is OUTSIDE this one. An unhandled route
            # exception therefore propagates through here as an exception and
            # the 500 response is synthesized above us — send_wrapper never
            # observes status=500. The `server_error` branch in _log_timing
            # only catches *explicit* 500 responses; this except is what covers
            # the unhandled case, which is the one worth diagnosing.
            #
            # log.exception (not .warning) so the traceback lands in the same
            # durable file sink as everything else, with the method/path/query
            # context that uvicorn's own "Exception in ASGI application" line
            # lacks. Re-raised unchanged: ServerErrorMiddleware still owns the
            # response, so status codes and error bodies are untouched.
            duration_ms = (time.perf_counter() - t0) * 1000
            query = scope.get("query_string", b"").decode("latin-1")[:_QUERY_LOG_MAX_CHARS]
            log.exception(
                "hoga_perf http_request status=500 method=%s path=%s%s%s "
                "duration_ms=%.1f server_error=1 unhandled=1",
                scope.get("method", "-"),
                scope.get("path", "-"),
                "?" if query else "",
                query,
                duration_ms,
            )
            raise
