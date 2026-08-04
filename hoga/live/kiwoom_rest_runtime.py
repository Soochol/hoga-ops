"""키움 REST seam·거버너의 프로세스 싱글턴 (`kis_capacity_runtime` 브로커-대칭).

`kiwoom_runtime` 이 토큰 provider 를 소유하듯, 이 모듈은 **REST 클라이언트와
유량 거버너**를 소유한다. 계층을 나눈 이유는 `kiwoom_runtime` 이 WS 경로에서도
쓰이는데 거기에 REST 거버너를 딸려 보낼 이유가 없기 때문이다.

거버너는 **프로세스당 하나**여야 한다 — TR별 버킷이 전수 호출을 봐야 유량이
지켜진다. 두 개가 뜨면 각자 5 req/s 를 쏴서 합이 10 이 된다.
"""
from __future__ import annotations

import logging
import threading
from pathlib import Path

from hoga.live.kiwoom_capacity import KiwoomCapacityScheduler
from hoga.live.kiwoom_rest import KiwoomRestClient
from hoga.live.kiwoom_runtime import (
    configured_account_ids,
    ensure_token_provider_for_account,
)

log = logging.getLogger(__name__)

_lock = threading.Lock()
_clients: dict[int, KiwoomRestClient] = {}
_scheduler: KiwoomCapacityScheduler | None = None


def ensure_rest_client(data_dir: Path, account_id: int = 0) -> KiwoomRestClient | None:
    """계정별 REST 클라이언트 싱글턴. 자격증명이 없으면 None — 호출자가 휴면한다.

    dev 무자격 프로필(ADR-0134)에서 None 이 정상 경로다.

    이전 판은 `_client` 전역 하나여서 **`account_id` 를 받고도 무시**했다 — 두 번째
    계정을 요청해도 첫 번째가 돌아왔다. 유량이 앱키별인 것이 실측되면서(ADR-0138)
    그 파라미터가 비로소 의미를 갖는다.
    """
    with _lock:
        client = _clients.get(account_id)
        if client is not None:
            return client
        prov = ensure_token_provider_for_account(account_id, data_dir)
        if prov is None:
            return None
        client = KiwoomRestClient(prov)
        _clients[account_id] = client
        return client


def ensure_rest_clients(data_dir: Path) -> list[KiwoomRestClient]:
    """설정된 **전 계정**의 클라이언트를 account_id 순으로. 자격증명이 없으면 빈 리스트.

    거버너의 계정 풀이 이 목록이다 — 유량이 앱키별이라 풀 크기가 곧 처리량 배수다
    (실측: 1키 4.17 → 2키 8.14 → 4키 18.4 콜/초).
    """
    return [
        client
        for client in (
            ensure_rest_client(data_dir, account_id)
            for account_id in configured_account_ids(data_dir)
        )
        if client is not None
    ]


def ensure_scheduler(data_dir: Path | None = None) -> KiwoomCapacityScheduler:
    """유량 거버너 싱글턴. **프로세스당 하나** — 둘이면 유량이 배가된다.

    `data_dir` 을 주면 계정 풀을 갱신한다. 생략하면 이미 등록된 풀을 그대로 쓴다
    (풀은 프로세스 싱글턴이라 한 곳에서 등록하면 전 호출자가 함께 혜택을 본다).
    """
    # 풀 해석은 **락 밖에서** 한다 — `ensure_rest_client` 가 같은 비재진입 락을
    # 잡으므로 안에서 부르면 데드락이다.
    clients = ensure_rest_clients(data_dir) if data_dir is not None else None
    global _scheduler  # noqa: PLW0603 — 문서화된 프로세스 싱글턴
    with _lock:
        if _scheduler is None:
            _scheduler = KiwoomCapacityScheduler()
        if clients:
            _scheduler.set_clients(clients)
        return _scheduler


def snapshot() -> dict[str, object]:
    """관측 표면. 거버너가 없으면 빈 dict — 호출자가 '미가동' 으로 읽는다."""
    return _scheduler.snapshot() if _scheduler is not None else {}


async def aclose() -> None:
    """프로세스 종료 경로. 거버너 워커를 먼저 세우고 **전 계정** 소켓을 닫는다."""
    global _scheduler  # noqa: PLW0603 — 문서화된 프로세스 싱글턴
    sched, clients = _scheduler, list(_clients.values())
    _scheduler = None
    _clients.clear()
    if sched is not None:
        await sched.aclose()
    for client in clients:
        await client.aclose()


def reset_for_tests() -> None:
    """테스트 격리 — 싱글턴 드롭. 비동기 정리는 하지 않는다(이벤트 루프 밖 호출 가능)."""
    global _scheduler  # noqa: PLW0603 — 문서화된 프로세스 싱글턴
    _clients.clear()
    _scheduler = None
