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
from dataclasses import dataclass
from pathlib import Path
from typing import Literal, TypeVar

from . import account_health, kis_runtime
from .kis_client import KisAuthError, KisClient

_T = TypeVar("_T")

# background 라운드로빈 커서 — account 1..N-1을 per-call 회전(부하 분산). 단일워커
# (ADR-0038)라 프로세스 전역 가변상태가 안전. N=2면 후보 1개라 항상 account 1(불변).
_bg_round_robin: int = 0


@dataclass(frozen=True)
class KisAccountLease:
    role: Literal["foreground", "background"]
    account_id: int
    client: KisClient


def acquire_account_for_role(
    role: str,
    data_dir: Path,
    *,
    allow_account0_fallback: bool = True,
) -> KisAccountLease | None:
    """role('foreground'|'background')에 따라 account별 KisClient lease를 반환한다.

    - foreground: 항상 account 0(사용자 전용 15/s, 백그라운드와 경합 없음).
    - background: account 1..N-1을 라운드로빈(N계좌 확장 — 인덱스 고정 탈피, 2026-06-10).
      REST-degraded(토큰 발급 실패)만 스킵한다 — **WS 저하(sub_failed)는 무관**(캡처 건강과
      REST 라우팅은 직교; account_health.is_rest_degraded). 후보가 비면 account 0 폴백.
      DailyKisFetchQueue는 allow_account0_fallback=False를 통해 foreground 보호
      상태에서 account 0 폴백을 명시적으로 금지할 수 있다.

    N=2 정상 분리에선 background 후보가 [1] 하나라 항상 account 1(기존 동작 보존). N≥3에서만
    1,2,…를 회전해 추가 계좌의 유휴 REST 버킷(15/s)을 활용한다.

    ensure_kis_client_for_account로 후보 REST 버킷을 *직접* 확보하는 이유: lifecycle은 작은
    관심목록에서 그 계좌의 WS conn을 안 만들 수 있다(빈 파티션). get_kis_client 의존이면
    조용히 acct0로 폴백해 다계좌 이득이 무효가 된다. ensure는 WS conn 유무와 무관하게 버킷을
    확보한다(첫 REST bearer 토큰 발급은 첫 호출에서 일어나므로 'REST 선접촉' 논거 무관, FM5)."""
    if role == "foreground":
        existing = kis_runtime.get_kis_client(0)
        client = existing if existing is not None else kis_runtime.ensure_kis_client_from_env(data_dir)
        if client is None:
            return None
        return KisAccountLease(role="foreground", account_id=0, client=client)

    if role == "background":
        candidates = [
            a for a in kis_runtime.configured_account_ids(data_dir)
            if a >= 1 and not account_health.is_rest_degraded(a)
        ]
        if candidates:
            global _bg_round_robin  # noqa: PLW0603
            pick = candidates[_bg_round_robin % len(candidates)]
            _bg_round_robin += 1
            client = kis_runtime.ensure_kis_client_for_account(pick, data_dir)
            if client is not None:
                return KisAccountLease(role="background", account_id=pick, client=client)
        if not allow_account0_fallback:
            return None
    else:
        raise ValueError(f"unknown KIS account role: {role}")

    # account 0 폴백: 이미 생성/주입된 싱글톤 우선(부팅 생성 + 라우트 fake 주입), 없으면
    # env에서 지연 생성(빈 관심목록·무갭일 등 싱글톤 미생성 상태 — /quotes lazy-init 승계).
    existing = kis_runtime.get_kis_client(0)
    if existing is not None:
        return KisAccountLease(role="background", account_id=0, client=existing)
    client = kis_runtime.ensure_kis_client_from_env(data_dir)
    if client is None:
        return None
    return KisAccountLease(role="background", account_id=0, client=client)


def kis_for_role(role: str, data_dir: Path) -> KisClient | None:
    lease = acquire_account_for_role(role, data_dir)
    return lease.client if lease is not None else None


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
