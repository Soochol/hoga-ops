"""KIS REST access seam for capacity-scheduled requests.

All KIS REST callers enter through `run_with_capacity`: that lets the scheduler
choose a healthy account from the dynamic pool, coalesce duplicate requests,
reserve capacity for user-visible work, fail over across accounts on a KIS
rate-limit response (ADR-0086), and cool down the rate-limited account.

레이어 분리:
  - kis_runtime = 리소스 소유(account별 KisClient 싱글톤 dict, ensure_*, env creds).
  - account_health = "account N degraded?"(REST 토큰 latch ∪ WS 저하).
  - kis_access(이 모듈) = semantic endpoint enum + scheduler adapter.
"""
from __future__ import annotations

from collections.abc import Awaitable, Callable, Hashable
from enum import StrEnum
from pathlib import Path
from typing import Literal, Protocol, TypeVar

from . import kis_runtime
from .kis_client import KisApiError, KisClient
from .settings import load_live_settings

_T = TypeVar("_T")
KisRequestPriority = Literal["user_visible", "background"]


class KisRestEndpoint(StrEnum):
    """Semantic KIS REST request names used by the capacity scheduler.

    Keep these values stable: they are part of scheduler cooldown keys, status
    snapshots, logs, and tests. Add a value here before introducing a new
    scheduled KIS REST caller.
    """

    INDEX_DAILY = "index-daily"
    INDEX_INVESTOR_NET = "index-investor-net"
    INDEX_MINUTE = "index-minute"
    INDEX_PRICE = "index-price"
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

async def run_with_capacity(
    scheduler: _KisCapacityScheduler,
    *,
    data_dir: Path,
    key: Hashable,
    endpoint: KisRestEndpoint,
    priority: KisRequestPriority,
    fetch_fn: Callable[[KisClient], Awaitable[_T]],
    cooldown_scope: Hashable | None = None,
) -> _T:
    """Run a KIS fetch through the capacity scheduler.

    The scheduler owns account-pool allocation, so callers no longer choose a
    client or a legacy role — `priority` (`user_visible` / `background`) is the
    single intent signal. Bypass is enforced before any submit.
    """
    _raise_if_bypassed(data_dir)
    endpoint_value = _endpoint_value(endpoint)
    return await scheduler.submit(
        key=key,
        endpoint=endpoint_value,
        priority=priority,
        cooldown_scope=cooldown_scope,
        call=fetch_fn,
    )
