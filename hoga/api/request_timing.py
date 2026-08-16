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
# 이 프로세스의 PID. 모듈 로드 1회 — 요청마다 os.getpid() 를 부를 이유가 없다.
#
# **왜 PID·포트를 로그에 싣나.** 이 리포는 병행 세션이 6개까지 늘고, 워크트리마다
# 백엔드를 띄우는데 로그 파일(`~/.local/share/hoga-ops/logs/hoga.log`)은 **하나**다.
# 여러 프로세스가 같은 파일에 append 하므로, 줄에 프로세스 식별자가 없으면 집계가
# 통째로 오염된다 — 2026-08-16 감사에서 `/api/heatmap/group-flow` p50 3.85 s / max
# 33.1 s 라는 수치가 나왔는데, 머신이 한산한 상태에서 사용자 dev 서버 하나로 다시 재니
# **630 ms** 였다(6배). 즉 그 p50 은 "이 라우트의 비용" 이 아니라 **병행 백엔드들이
# 경합한 값**이었고, 줄만 봐서는 그걸 구별할 방법이 없었다.
#
# 이건 성능 결함이 아니라 **계측 인프라 결함**이다. 앞으로도 slow-log 기반 판단이
# 전부 같은 방식으로 오염되므로, 여기서 한 번 고쳐 둔다.
# 판별식: `grep hoga_perf hoga.log | grep -o 'pid=[0-9]*' | sort -u | wc -l` 이 1 보다
# 크면 그 구간의 집계는 단일 서버 수치가 아니다.
_PID = os.getpid()
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
    # `scope["server"]` = (host, port). uvicorn 이 채우지만 ASGI 스펙상 선택 필드라
    # 부재를 허용한다 — 그 경우 `-` 로 두고 PID 만으로 구별한다.
    server = scope.get("server") or (None, None)
    port = server[1] if len(server) > 1 and server[1] is not None else "-"
    log.warning(
        "hoga_perf http_request pid=%s port=%s status=%d method=%s path=%s%s%s "
        "ttfb_ms=%.1f duration_ms=%.1f%s%s%s%s",
        _PID,
        port,
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
