"""키움 REST 접근 seam (`kis_access` 브로커-대칭).

**모든 키움 REST 호출자는 `run_with_capacity` 를 통과한다.** 그래야 거버너가
전수 호출을 보고 TR별 유량을 지킨다.

## 이 모듈이 존재하는 진짜 이유 — 테스트 이음매

#1010 전수조사가 확인한 것: KIS 테스트 스위트의 페이크-브로커 이음매가
`kis_access.run_with_capacity` **한 곳**이다. 몽키패치 한 번이면 전 호출자가
페이크로 바뀐다. 그 seam 이 없으면 간접 테스트 75개가 **각자 다른 방식으로**
페이크를 만들게 된다.

그래서 이건 편의 함수가 아니라 **설계 요구사항**이다(ADR-0136 §2).

2층 구조다:
  - **소비자 테스트**: 이 함수 하나를 몽키패치
  - **seam 자체 테스트**: `KiwoomRestClient(transport=httpx.MockTransport(...))`
    로 실제 파싱·커서·에러 분류를 돌린다
"""
from __future__ import annotations

from collections.abc import Awaitable, Callable, Hashable
from typing import Protocol, TypeVar

from hoga.live.kiwoom_capacity import Priority
from hoga.live.kiwoom_rest import KiwoomRestClient

_T = TypeVar("_T")


class _Scheduler(Protocol):
    async def submit(
        self,
        *,
        key: Hashable,
        api_id: str,
        priority: Priority,
        call: Callable[[KiwoomRestClient | None], Awaitable[_T]],
    ) -> _T: ...


async def run_with_capacity(
    scheduler: _Scheduler,
    *,
    key: Hashable,
    api_id: str,
    priority: Priority,
    fetch_fn: Callable[[KiwoomRestClient], Awaitable[_T]],
    client: KiwoomRestClient,
) -> _T:
    """키움 fetch 를 거버너를 통해 실행한다.

    `priority` 가 유일한 의도 신호다 — `user_visible`(인터랙티브) 또는
    `background`(백필·워밍).

    `key` 는 중복제거 단위다. 같은 key 가 이미 떠 있으면 새 호출 없이 그
    결과에 조인한다.

    **계정은 거버너가 고른다**(ADR-0138). 유량이 TR별인 **동시에 앱키별**이라
    풀이 크면 처리량이 그만큼 는다. `client` 는 풀이 비었을 때(자격증명 1벌,
    테스트)만 쓰이는 폴백이다 — 넘긴 클라이언트가 항상 쓰인다고 가정하지 말 것.
    """
    return await scheduler.submit(
        key=key,
        api_id=api_id,
        priority=priority,
        call=lambda picked: fetch_fn(picked if picked is not None else client),
    )
