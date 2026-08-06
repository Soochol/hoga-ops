"""키움 REST 접근 seam (`kis_access` 브로커-대칭).

**키움 REST 호출자는 `run_with_capacity` 를 통과해야 한다.** 그래야 거버너가 전수
호출을 보고 TR별 유량을 지킨다.

**이건 규범이지 자동으로 보장되는 성질이 아니다.** 클라이언트는 `ensure_rest_client`
로 아무 데서나 얻을 수 있고 `client.call()` 은 그냥 불린다 — 우회를 막는 장치가 없다.
2026-08-07 감사에서 실제로 세 곳이 우회 중이었다(저장뷰 캔들 복구 `ka10080` ·
거래일 오버레이 `ka20006` · 종목 마스터 `ka10099`). 우회하면 잃는 것이 셋이다:

1. **유량 페이싱** — 그 콜이 TR 버킷을 안 거쳐 거버너 눈에 보이지 않는다.
2. **토큰 revoke(8005) 자동복구** — 복구가 클라이언트가 아니라 **여기(거버너)에**
   있다(PR #1088). 우회 경로는 죽은 토큰으로 실패하고도 재발급이 안 걸려 **조용히
   멈춘다** — 시드·캐시가 답을 계속 주므로 화면엔 증상이 없다.
3. **테스트 페이크** — 아래 몽키패치가 안 먹어 실 벤더를 친다.

새 호출 지점을 만들 때 `client.call()`/`client.walk()` 를 직접 부르고 있다면 그건
버그다. 여러 콜을 도는 함수는 **콜마다 1 submit** 이어야 하므로 러너를 주입받는다
(`kiwoom_master.fetch_symbol_master(run_call=…)` · `KiwoomRestClient.walk(run_page=…)`).

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
