"""상태 변경 요청의 Origin 검사 — 브라우저 경유 교차 출처 호출 차단.

**CORS 는 이걸 막아 주지 않는다.** Starlette 의 ``CORSMiddleware`` 는
``method == "OPTIONS" and "access-control-request-method" in headers`` 일 때만
preflight 응답으로 차단하고, 그 밖의 요청은 origin 이 화이트리스트 밖이어도
**핸들러를 그대로 실행한 뒤** 응답 헤더만 빼놓는다(설치본 ``cors.py:91-96`` 확인).
브라우저가 응답을 못 읽는 것은 무의미하다 — 부작용은 이미 확정됐다.

그리고 이 API 에는 **파라미터가 하나도 없는 상태변경 라우트** 가 있다(2026-07-30
기준 6건: symbols/refresh · screener/update · watchlist/catchup ·
captures/cancel-all · captures/queue/resume · captures/done DELETE).
파라미터가 없으면 FastAPI 가 body 를 파싱하지 않으므로
``application/x-www-form-urlencoded`` 로 도달하고, 그건 CORS-safe content-type 이라
**preflight 자체가 발생하지 않는다.** 즉 악성 페이지의 숨은 ``<form>`` 자동 제출로
그대로 호출된다.

부작용은 되돌릴 수 없다. ``cancel_all()`` 은 대기 큐를 전량 popleft 해 cancelled 로
넘기고 실행 중 항목의 cancel_token 을 취소한 뒤 ``_persist_queue_locked()`` 로
디스크에 확정한다. 장중이면 hogaplay 업스트림 보유가 ~18시간이라 다음날 재수집 시
오전분이 영구 소실된다. ``watchlist/catchup`` 은 관심종목 전체 × 미보유 거래일을
큐에 밀어넣어 사용자 세션으로 대량 스크래핑을 유발한다(업스트림 밴 위험).

이건 ADR-0036 이 스코프 밖으로 규정한 "네트워크 노출 배포" 얘기가 아니다.
README 가 규정한 **로컬 단독 실행에서 그대로 성립**한다 — 사용자가 `hoga serve` 를
켜둔 채 브라우저로 아무 페이지나 열면 된다.

**WebSocket 핸드셰이크도 검사한다.** 핸드셰이크는 GET 이지만 아래 `_SAFE_METHODS`
면제를 받지 못한다. GET 을 면제하는 근거는 "부작용이 없고, 응답은 CORS 가 읽기를
막아 준다" 인데 WS 는 두 전제가 모두 깨진다:

1. **읽기 보호가 아예 없다.** CORS 는 WebSocket 에 적용되지 않는다 — 브라우저는
   교차 출처 페이지에 양방향 소켓을 그대로 넘긴다. `ch:'live'` 프레임의 실시간
   호가·체결·거래원과 `ch:'event'` 의 캡처 큐 진행이 전량 읽힌다.
2. **부작용이 있다.** `{"action":"subscribe","code":...}` 는 키움 표시 슬롯 장부를
   변경한다(`lifecycle.on_view_subscribe`). 슬롯은 계정당 200 개로 유계라, 악성
   페이지가 임의 종목을 밀어넣어 **정상 탭을 만석으로 밀어낼 수 있다.**

설계 원칙 세 가지:

1. **CORSMiddleware 보다 바깥에 둔다.** 안쪽이면 CORS 가 통과시킨 뒤라 의미가 없다.
2. **비브라우저 클라이언트를 막지 않는다.** curl · 스크립트 · CLI 는 ``Origin`` 도
   ``Sec-Fetch-Site`` 도 보내지 않으므로 통과시킨다. 이 가드가 막으려는 것은
   "브라우저가 다른 출처의 지시로 보낸 요청" 이지 "인증 없는 요청" 이 아니다 —
   인증은 ADR-0036 이 명시적으로 스코프 밖으로 둔 별개 주제다.
3. **판정 로직은 HTTP 와 WS 가 공유한다** (``_is_allowed`` 하나). 두 벌로 두면 한쪽만
   고쳐져 조용히 어긋난다 — 이 저장소가 이미 겪은 실패 형태다.
"""
from __future__ import annotations

import logging

log = logging.getLogger(__name__)

# 본문 없는 상태변경 요청은 preflight 를 만들지 않으므로 여기서 걸러야 한다.
# GET/HEAD 는 부작용이 없고, OPTIONS 는 CORSMiddleware 가 처리한다.
_SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})

# 브라우저가 "이 요청은 같은 출처에서 시작됐다" 고 말하는 값들.
# cross-site / same-site 는 통과시키지 않는다 — 공격 페이지가 서브도메인에 있어도
# 막아야 하고, 정상 프론트엔드는 아래 allowed_origins 로 이미 통과한다.
_SELF_INITIATED_FETCH_SITES = frozenset({"same-origin"})


class OriginGuardMiddleware:
    """상태 변경 요청에 대해 브라우저 출처를 검사하는 순수 ASGI 미들웨어.

    ``BaseHTTPMiddleware`` 를 쓰지 않는 이유는 RequestTimingMiddleware 와 같다 —
    스트리밍 응답의 수명을 붙잡지 않기 위해서다. 여기서는 거부 시 응답을 직접
    조립하므로 의존도 더 낮다.
    """

    def __init__(self, app, *, allowed_origins: tuple[str, ...]) -> None:
        self.app = app
        self._allowed = frozenset(allowed_origins)

    async def __call__(self, scope, receive, send) -> None:
        scope_type = scope["type"]
        if scope_type == "http":
            if scope.get("method") in _SAFE_METHODS:
                await self.app(scope, receive, send)
                return
        elif scope_type != "websocket":
            # lifespan 등 — 브라우저가 만드는 scope 가 아니다.
            await self.app(scope, receive, send)
            return

        headers = {
            k.decode("latin-1").lower(): v.decode("latin-1")
            for k, v in scope.get("headers", [])
        }
        origin = headers.get("origin")
        fetch_site = headers.get("sec-fetch-site")

        if self._is_allowed(origin, fetch_site):
            await self.app(scope, receive, send)
            return

        # 거부는 조용하면 안 된다 — 정상 프론트엔드가 새 포트로 옮겨 갔을 때
        # "왜 저장이 안 되지" 의 유일한 단서가 이 로그다.
        log.warning(
            "origin_guard: blocked %s %s origin=%r sec-fetch-site=%r "
            "(allowed=%s) — 브라우저 교차 출처 %s",
            scope.get("method") or scope_type.upper(), scope.get("path"),
            origin, fetch_site, sorted(self._allowed),
            "WS 핸드셰이크" if scope_type == "websocket" else "상태변경 요청",
        )
        if scope_type == "websocket":
            await _reject_ws(send)
            return
        await _reject(send)

    def _is_allowed(self, origin: str | None, fetch_site: str | None) -> bool:
        # 비브라우저(curl/스크립트/CLI): 두 헤더 모두 없다 → 통과.
        # 이 가드는 인증 장치가 아니다(ADR-0036 참고).
        if origin is None and fetch_site is None:
            return True
        if origin is not None:
            return origin in self._allowed
        # Origin 이 없고 Sec-Fetch-Site 만 있는 경우(일부 브라우저의 same-origin POST).
        return fetch_site in _SELF_INITIATED_FETCH_SITES


async def _reject_ws(send) -> None:
    """accept 전에 close 를 보내 핸드셰이크를 거부한다(ASGI 규약: 서버가 HTTP 403 응답).

    ``receive()`` 로 ``websocket.connect`` 를 먼저 소비하지 않는 것은 Starlette 자신의
    ``WebSocketClose`` 와 같은 형태다(라우트 미스 시 그렇게 거부한다). 1008 =
    policy violation.
    """
    await send({
        "type": "websocket.close",
        "code": 1008,
        "reason": "cross_origin_blocked",
    })


async def _reject(send) -> None:
    body = (
        b'{"code":"cross_origin_blocked",'
        b'"message":"Cross-origin state-changing request blocked. '
        b'This API is local-only; see README."}'
    )
    await send({
        "type": "http.response.start",
        "status": 403,
        "headers": [
            (b"content-type", b"application/json"),
            (b"content-length", str(len(body)).encode("latin-1")),
        ],
    })
    await send({"type": "http.response.body", "body": body})
