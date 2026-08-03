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
from hoga.live.kiwoom_runtime import ensure_token_provider_for_account

log = logging.getLogger(__name__)

_lock = threading.Lock()
_client: KiwoomRestClient | None = None
_scheduler: KiwoomCapacityScheduler | None = None


def ensure_rest_client(data_dir: Path, account_id: int = 0) -> KiwoomRestClient | None:
    """REST 클라이언트 싱글턴. 자격증명이 없으면 None — 호출자가 휴면한다.

    dev 무자격 프로필(ADR-0134)에서 None 이 정상 경로다.
    """
    global _client  # noqa: PLW0603 — 문서화된 프로세스 싱글턴
    with _lock:
        if _client is not None:
            return _client
        prov = ensure_token_provider_for_account(account_id, data_dir)
        if prov is None:
            return None
        _client = KiwoomRestClient(prov)
        return _client


def ensure_scheduler() -> KiwoomCapacityScheduler:
    """유량 거버너 싱글턴. **프로세스당 하나** — 둘이면 유량이 배가된다."""
    global _scheduler  # noqa: PLW0603 — 문서화된 프로세스 싱글턴
    with _lock:
        if _scheduler is None:
            _scheduler = KiwoomCapacityScheduler()
        return _scheduler


def snapshot() -> dict[str, object]:
    """관측 표면. 거버너가 없으면 빈 dict — 호출자가 '미가동' 으로 읽는다."""
    return _scheduler.snapshot() if _scheduler is not None else {}


async def aclose() -> None:
    """프로세스 종료 경로. 거버너 워커를 먼저 세우고 소켓을 닫는다."""
    # 문서화된 프로세스 싱글턴 재바인딩
    global _client, _scheduler
    sched, cli = _scheduler, _client
    _scheduler, _client = None, None
    if sched is not None:
        await sched.aclose()
    if cli is not None:
        await cli.aclose()


def reset_for_tests() -> None:
    """테스트 격리 — 싱글턴 드롭. 비동기 정리는 하지 않는다(이벤트 루프 밖 호출 가능)."""
    # 문서화된 프로세스 싱글턴 재바인딩
    global _client, _scheduler
    _client, _scheduler = None, None
