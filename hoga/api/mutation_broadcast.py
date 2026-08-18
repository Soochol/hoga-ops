"""변경 라우트 → EventBus 브로드캐스트(교차 브라우저 목록 동기화).

관심목록·히트맵 문서는 **서버가 진실**이지만, 지금까지 다른 탭·다른 브라우저는
자기가 캐시한 GET 응답을 계속 들고 있었다 — 한쪽 창에서 종목을 추가해도 다른
창은 새로고침(또는 관심목록의 60초 폴링) 전까지 모른다. 프론트가
``refetchOnWindowFocus`` 를 일부러 꺼 둔 터라(main.tsx) 탭 전환도 신호가 아니다.

이 모듈은 **변경 라우트가 2xx 로 끝나면** "바뀌었다" 신호 하나를 EventBus 에
실어, ``/api/ws`` 에 붙어 있는 모든 연결이 그 목록 쿼리를 무효화하게 한다.
전송 계층은 손대지 않는다 — ws.py 의 ``pump_event`` 가 bus 이벤트를 이미 모든
연결에 중계한다(ADR-0053).

**왜 핸들러마다 publish 하지 않고 route_class 인가**: 두 라우터의 변경 핸들러가
26개다. 개별 publish 는 새 라우트를 추가할 때 조용히 새고, 그 누락은 "가끔 다른
창이 안 따라온다"는 무증상 실패로만 드러난다 — 그때는 이미 원인 후보가 WS·캐시·
백엔드로 흩어져 있다. route_class 는 그 라우터에 등록되는 **모든** 경로를 덮으므로
새 변경 라우트가 기본으로 커버된다.

**이 가드가 못 보는 것**(닫는 방향의 반대편):

- 라우트를 타지 않는 쓰기. 스케줄러·캡처 워커가 ``last_success_date`` 를 갱신하는
  경로는 여기로 오지 않는다(브로드캐스트 없음). 사용자 편집의 교차 창 반영이
  목표이므로 의도적 비대상이다.
- 다른 라우터에 새로 생기는 목록 변경 라우트. 이 route_class 를 **지정한** 라우터
  안에서만 자동이다.
- 부작용 없는 변경 메서드. 예컨대 관심목록 ``POST /catchup`` 은 문서를 바꾸지 않고
  캡처를 큐에 넣을 뿐인데 2xx 라 발행된다. 수신 측 비용이 가벼운 GET 1회라
  스퓨리어스를 감수했다 — 경로 예외 목록을 두면 그 목록 자체가 새 누락 지점이 된다.
"""
from __future__ import annotations

from collections.abc import Callable, Coroutine
from typing import TYPE_CHECKING, Any

from fastapi import Request, Response
from fastapi.routing import APIRoute

if TYPE_CHECKING:
    from hoga.api.events import EventBus

# 본문을 바꿀 수 있는 메서드. GET/HEAD/OPTIONS 는 읽기이므로 발행하지 않는다 —
# 같은 라우터가 목록 GET 도 들고 있어서 이 필터가 없으면 조회가 조회를 부른다.
MUTATING_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})

_HTTP_OK = 200
_HTTP_MULTIPLE_CHOICES = 300


def mutation_broadcast_route_class(
    bus: EventBus | None,
    event_type: str,
) -> type[APIRoute]:
    """``event_type`` 을 브로드캐스트하는 APIRoute 서브클래스.

    ``bus`` 가 None 이면 기본 ``APIRoute`` 를 그대로 돌려준다 — 라우터 조립부가
    분기하지 않아도 되고, bus 를 주입하지 않는 기존 라우터 테스트가 그대로 돈다.
    """
    if bus is None:
        return APIRoute

    class _BroadcastRoute(APIRoute):
        def get_route_handler(self) -> Callable[[Request], Coroutine[Any, Any, Response]]:
            handler = super().get_route_handler()

            async def broadcast(request: Request) -> Response:
                # 핸들러가 예외를 던지면(HTTPException 포함) 여기서 그대로 전파되고
                # 발행은 일어나지 않는다 — 실패한 변경은 남에게 알릴 것이 없다.
                response = await handler(request)
                if (
                    request.method in MUTATING_METHODS
                    and _HTTP_OK <= response.status_code < _HTTP_MULTIPLE_CHOICES
                ):
                    bus.publish({"type": event_type})
                return response

            return broadcast

    return _BroadcastRoute
