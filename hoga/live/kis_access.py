"""KIS REST access seam for capacity-scheduled requests.

Capacity-scheduled callers should enter through `run_with_capacity`: that lets
the scheduler choose a healthy account from the dynamic pool, coalesce duplicate
requests, reserve capacity for user-visible work, and cool down accounts after a
KIS rate-limit response.

`kis_for_role` / `fetch_for_role` remain only for legacy compatibility tests and
emergency fallback code. New production callers should not use them directly.

레이어 분리:
  - kis_runtime = 리소스 소유(account별 KisClient 싱글톤 dict, ensure_*, env creds).
  - account_health = "account N degraded?"(REST 토큰 latch ∪ WS 저하).
  - kis_access(이 모듈) = semantic endpoint enum + scheduler adapter + legacy fallback.
"""
from __future__ import annotations

from collections.abc import Awaitable, Callable, Hashable
from enum import StrEnum
from pathlib import Path
from typing import Literal, Protocol, TypeVar

from . import account_health, kis_runtime
from .kis_client import KisApiError, KisAuthError, KisClient
from .settings import load_live_settings

_T = TypeVar("_T")
KisRequestPriority = Literal["user_visible", "background"]
KisLegacyRole = Literal["foreground", "background"]


class KisRestEndpoint(StrEnum):
    """Semantic KIS REST request names used by the capacity scheduler.

    Keep these values stable: they are part of scheduler cooldown keys, status
    snapshots, logs, and tests. Add a value here before introducing a new
    scheduled KIS REST caller.
    """

    INDEX_DAILY = "index-daily"
    INDEX_INVESTOR_NET = "index-investor-net"
    INDEX_MINUTE = "index-minute"
    LIVE_BROKERS = "live-brokers"
    LIVE_ORDERBOOK = "live-orderbook"
    LIVE_TRADES = "live-trades"
    INVESTOR_NET = "investor-net"
    INVESTOR_TREND_ESTIMATE = "investor-trend-estimate"
    PAST_DAILY = "past-daily"
    PAST_MINUTE = "past-minute"
    PROGRAM_TRADE = "program-trade"
    QUOTES = "quotes"
    SCREENER_DAILY = "screener-daily"


class KisRestBypassedError(KisApiError):
    def __init__(self) -> None:
        super().__init__(
            msg_cd="KIS_REST_BYPASSED",
            msg1="KIS REST bypass is enabled",
        )


def _endpoint_value(endpoint: KisRestEndpoint) -> str:
    if not isinstance(endpoint, KisRestEndpoint):
        raise TypeError("endpoint must be a KisRestEndpoint")
    return endpoint.value


def kis_rest_bypass_enabled(data_dir: Path) -> bool:
    return load_live_settings(data_dir).kis_rest_bypass_enabled


def _raise_if_bypassed(data_dir: Path) -> None:
    if kis_rest_bypass_enabled(data_dir):
        raise KisRestBypassedError()


def has_rest_capacity(data_dir: Path) -> bool:
    """Return whether at least one KIS REST account can be resolved.

    This preserves the old "skip when creds are absent" behavior for background
    jobs while avoiding a direct legacy background-role reservation before handing
    the request to the capacity scheduler.
    """
    if kis_runtime.configured_account_ids(data_dir):
        return True
    if kis_runtime.get_kis_client(0) is not None:
        return True
    return kis_runtime.ensure_kis_client_from_env(data_dir) is not None


class _KisCapacityScheduler(Protocol):
    async def submit(
        self,
        *,
        key: Hashable,
        endpoint: str,
        priority: KisRequestPriority,
        call: Callable[[KisClient], Awaitable[_T]],
        cooldown_scope: Hashable | None = None,
    ) -> _T: ...

# background 라운드로빈 커서 — account 1..N-1을 per-call 회전(부하 분산). 단일워커
# (ADR-0038)라 프로세스 전역 가변상태가 안전. N=2면 후보 1개라 항상 account 1(불변).
_bg_round_robin: int = 0


def kis_for_role(role: KisLegacyRole, data_dir: Path) -> KisClient | None:
    """Legacy role-routed client resolver.

    Capacity-scheduled production callers should use `run_with_capacity`.
    This remains for legacy compatibility tests and fallback paths where no
    scheduler can be injected yet.

    role('foreground'|'background')에 따라 account별 KisClient를 반환한다(호출 시점
    평가 -> degraded 동적 폴백, 별도 상태 동기화 불필요).

    - foreground: 항상 account 0(legacy foreground behavior).
    - background: account 1..N-1을 라운드로빈(N계좌 확장 — 인덱스 고정 탈피, 2026-06-10).
      REST-degraded(토큰 발급 실패)만 스킵한다 — **WS 저하(sub_failed)는 무관**(캡처 건강과
      REST 라우팅은 직교; account_health.is_rest_degraded). 후보가 비면 account 0 폴백.

    N=2 정상 분리에선 background 후보가 [1] 하나라 항상 account 1(기존 동작 보존). N≥3에서만
    1,2,…를 회전해 추가 계좌의 유휴 REST 버킷(15/s)을 활용한다.

    ensure_kis_client_for_account로 후보 REST 버킷을 *직접* 확보하는 이유: lifecycle은 작은
    관심목록에서 그 계좌의 WS conn을 안 만들 수 있다(빈 파티션). get_kis_client 의존이면
    조용히 acct0로 폴백해 다계좌 이득이 무효가 된다. ensure는 WS conn 유무와 무관하게 버킷을
    확보한다(첫 REST bearer 토큰 발급은 첫 호출에서 일어나므로 'REST 선접촉' 논거 무관, FM5)."""
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
                return client
    # account 0 폴백: 이미 생성/주입된 싱글톤 우선(부팅 생성 + 라우트 fake 주입), 없으면
    # env에서 지연 생성(빈 관심목록·무갭일 등 싱글톤 미생성 상태 — /quotes lazy-init 승계).
    existing = kis_runtime.get_kis_client(0)
    if existing is not None:
        return existing
    return kis_runtime.ensure_kis_client_from_env(data_dir)


async def fetch_for_role(
    role: KisLegacyRole, data_dir: Path, fetch_fn: Callable[[KisClient], Awaitable[_T]]
) -> _T:
    """Legacy role fallback executor.

    Prefer `run_with_capacity` for background production requests. This helper
    runs `fetch_fn` with the role-resolved client and, on `KisAuthError`, resolves
    the role once more before retrying. That preserves the old FM5 behavior:
    when account 1 token issuance latches that account as REST-degraded, a
    second background resolution can fall back to account 0.

    client 미해결(creds 전무) 또는 재해결이 동일 client(N=1/이미 account 0)면 KisAuthError를
    전파한다 — 호출부가 침묵 사망 없이 실패를 표면화하도록."""
    _raise_if_bypassed(data_dir)
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


async def run_with_capacity(
    scheduler: _KisCapacityScheduler | None,
    *,
    data_dir: Path,
    role: KisLegacyRole,
    key: Hashable,
    endpoint: KisRestEndpoint,
    priority: KisRequestPriority,
    fetch_fn: Callable[[KisClient], Awaitable[_T]],
    cooldown_scope: Hashable | None = None,
) -> _T:
    """Run a KIS fetch through the capacity scheduler.

    Production callers pass a scheduler so account-pool allocation owns the
    client choice. `scheduler=None` is retained only as a legacy test/fallback
    path and keeps the old role-routed auth-fallback behavior.
    """
    _raise_if_bypassed(data_dir)
    endpoint_value = _endpoint_value(endpoint)
    if scheduler is None:
        return await fetch_for_role(role, data_dir, fetch_fn)
    return await scheduler.submit(
        key=key,
        endpoint=endpoint_value,
        priority=priority,
        cooldown_scope=cooldown_scope,
        call=fetch_fn,
    )
