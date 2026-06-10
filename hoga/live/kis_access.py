"""Role-routed KIS access — "내 role에 맞는 KisClient를 다오"의 단일 seam (계정 분리 2026-06-10).

계정 분리로 foreground(사용자가 차트 그려지길 기다리는 past-candles/daily)는 account 0
전용, background(rest_poller·quotes·investor·Screener)는 account 1(유휴였던 REST 버킷)으로
간다. 이 라우팅 정책 + FM5 폴백을 *한 곳*에 모은다 — 이전엔 api `_kis_for_background`,
poller resolver 람다, screener 직접 호출, kis_runtime.kis_for_role로 5가지 모양에 흩어졌다.

레이어 분리:
  - kis_runtime = 리소스 소유(account별 KisClient 싱글톤 dict, ensure_*, env creds).
  - account_health = "account N degraded?"(REST 토큰 latch ∪ WS 저하).
  - kis_access(이 모듈) = role→account 라우팅 + 인증 폴백. 둘을 소비, 양쪽을 import(순환 0).
"""
from __future__ import annotations

from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import TypeVar

from . import account_health, kis_runtime
from .kis_client import KisAuthError, KisClient

_T = TypeVar("_T")


def kis_for_role(role: str, data_dir: Path) -> KisClient | None:
    """role('foreground'|'background')에 따라 account별 KisClient를 반환한다(호출 시점
    평가 → degraded 동적 폴백, 별도 상태 동기화 불필요).

    - foreground: 항상 account 0(사용자 전용 15/s, 백그라운드와 경합 없음).
    - background: N≥2 & account 1 비-degraded면 account 1(ensure로 WS 유무와 무관하게
      REST 버킷 확보), 아니면 account 0 폴백.

    N=2 정상 분리에선 acct0=foreground만·acct1=background만이라 ② foreground 우선순위는
    dormant. N=1/degraded 폴백 시 공유 버킷이 되어 ②가 활성화된다.

    background가 ensure_kis_client_for_account(1)로 acct1 REST 버킷을 *직접* 확보하는
    이유: lifecycle은 작은 관심목록(≤13종목)에서 conn[1]을 안 만든다(빈 파티션 →
    연결 없음, lifecycle §6). get_kis_client(1)에 의존하면 그 흔한 경우에 acct1이
    None이라 조용히 acct0로 폴백 → 30/s 이득이 무효가 된다. ensure는 WS conn 유무와
    무관하게(관심목록 크기와 무관하게) acct1 버킷을 확보한다. 첫 REST bearer 토큰
    발급은 ensure/get 무관하게 첫 호출에서 일어나므로(FM5) 'REST 선접촉 회피' 논거는
    적용되지 않는다."""
    if (role == "background" and 1 in kis_runtime.configured_account_ids(data_dir)
            and not account_health.is_degraded(1)):
        client = kis_runtime.ensure_kis_client_for_account(1, data_dir)
        if client is not None:
            return client
    # account 0 폴백: 이미 생성/주입된 싱글톤 우선(부팅 생성 + 라우트 fake 주입), 없으면
    # env에서 지연 생성(빈 관심목록·무갭일 등 싱글톤 미생성 상태 — /quotes lazy-init 승계).
    existing = kis_runtime.get_kis_client(0)
    if existing is not None:
        return existing
    return kis_runtime.ensure_kis_client_from_env(data_dir)


async def fetch_for_role(
    role: str, data_dir: Path, fetch_fn: Callable[[KisClient], Awaitable[_T]]
) -> _T:
    """role의 client로 fetch_fn을 실행하되, KisAuthError면 role을 *재해결*해 1회 재시도(FM5).

    background에서 account 1 REST 토큰 실패 시 첫 호출이 provider 콜백으로 acct1을 latch한
    뒤, 재해결이 account 0를 반환해 그 fetch를 살린다. 스크리너 배치(client를 한 번 해결해
    여러 코드 재사용)용 — run_update의 gather가 첫 실패에 배치를 중단시키므로 per-call 폴백이
    필요하다. 폴러/quotes/investor는 매 사이클·요청 재해결이라 latch만으로 self-heal → 이
    헬퍼 불필요. foreground는 재해결이 동일 account 0 client라 폴백 없이 전파(폴백 대상 없음).

    client 미해결(creds 전무) 또는 재해결이 동일 client(N=1/이미 account 0)면 KisAuthError를
    전파한다 — 호출부가 침묵 사망 없이 실패를 표면화하도록."""
    client = kis_for_role(role, data_dir)
    if client is None:
        raise KisAuthError(f"no KIS client available for role={role} (creds missing)")
    try:
        return await fetch_fn(client)
    except KisAuthError:
        client2 = kis_for_role(role, data_dir)  # latch 후 재해결(background → account 0)
        if client2 is None or client2 is client:
            raise
        return await fetch_fn(client2)
