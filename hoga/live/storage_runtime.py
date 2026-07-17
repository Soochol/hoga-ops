"""Apply Live storage targets to the WS capture runtimes (KIS 관심종목 + 키움 히트맵).

KIS REST 30s 캡처(ADR-0097 rest30)는 제거됐다(2026-07-17 정책: 호가는 api로 받지
않는다 — 폴백 없음, 커버리지는 WS+계좌 추가로). 이 모듈은 이제 관심종목 WS 타깃
계획과 키움 세션·프로그램매매 사이드카의 정합화만 담당한다.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

log = logging.getLogger(__name__)

from . import kis_runtime
from .coverage import (
    KIWOOM_PER_ACCOUNT_MAX,
    _compute_capture_candidates,
    _compute_heatmap_codes,
    plan_storage_targets,
)
from .buffer import LiveBuffer
from .kis_capacity_runtime import ensure_kis_capacity_scheduler
from .settings import load_live_settings


class ProgramTradeCollectorLike(Protocol):
    def start(self) -> None: ...
    async def stop(self) -> None: ...


class KiwoomSessionLike(Protocol):
    async def sync(self, kiwoom_targets: tuple[str, ...], *, n_accounts: int) -> None: ...
    async def watchdog_pass(self, now_ms: int) -> None: ...
    async def on_view_subscribe(self, code: str, venues: set[str], *, ref: str) -> bool: ...
    async def on_view_unsubscribe(self, code: str, venues: set[str], *, ref: str) -> None: ...
    def active_codes(self) -> list[str]: ...
    def status(self) -> dict: ...
    async def stop(self) -> None: ...


class StorageRuntimeState(Protocol):
    program_trade_collector: ProgramTradeCollectorLike | None
    kiwoom_session: KiwoomSessionLike | None


@dataclass(frozen=True, slots=True)
class StorageRuntimeSnapshot:
    ws_targets: tuple[str, ...]
    # 키움 WS 수집 대상(ADR-0116). lifecycle이 SignalAlertMonitor 타깃 합집합에 쓴다.
    kiwoom_targets: tuple[str, ...] = ()


def _ensure_kiwoom_session(
    state: StorageRuntimeState,
    *,
    data_dir: Path,
    buffer: LiveBuffer,
    date_fn: Callable[[], str],
    now_ms_fn: Callable[[], int],
) -> KiwoomSessionLike:
    """키움 세션 매니저 싱글톤(state 소유). ws_connection_window 게이트로 KIS와 동일한
    연결 시간대(08~20)를 쓴다 — 저장 게이트(정규장)는 LiveStream 내부 flush 루프가 유지."""
    if state.kiwoom_session is not None:
        return state.kiwoom_session
    from .kiwoom_session import KiwoomSessionManager  # noqa: PLC0415
    from .session_gate import ws_connection_window  # noqa: PLC0415

    mgr = KiwoomSessionManager(
        buffer=buffer,
        data_dir=data_dir,
        date_fn=date_fn,
        gate_fn=lambda: ws_connection_window(now_ms_fn()),
        now_fn=now_ms_fn,  # venue 스왑·warmup 술어의 시각원(워치독과 공유)
    )
    state.kiwoom_session = mgr
    return mgr


def _ensure_program_trade_collector(
    state: StorageRuntimeState,
    *,
    data_dir: Path,
    date_fn: Callable[[], str],
    now_ms_fn: Callable[[], int],
) -> ProgramTradeCollectorLike:
    from .program_trade_collector import ProgramTradeCollector  # noqa: PLC0415

    if state.program_trade_collector is not None:
        return state.program_trade_collector
    collector = ProgramTradeCollector(
        data_dir=data_dir,
        date_fn=date_fn,
        now_ms_fn=now_ms_fn,
        scheduler=ensure_kis_capacity_scheduler(data_dir),
    )
    state.program_trade_collector = collector
    return collector


async def sync_storage_runtime(
    data_dir: Path,
    *,
    state: StorageRuntimeState,
    buffer: LiveBuffer,
    date_fn: Callable[[], str],
    now_ms_fn: Callable[[], int],
    n_configured: int | None = None,
) -> StorageRuntimeSnapshot:
    """Load settings, plan targets, and sync the WS capture runtimes."""
    settings = load_live_settings(data_dir)
    bypass = settings.kis_rest_bypass_enabled
    if n_configured is None:
        n_configured = len(kis_runtime.configured_account_ids(data_dir))
    from . import kiwoom_runtime  # noqa: PLC0415
    n_kiwoom = len(kiwoom_runtime.configured_account_ids(data_dir))
    targets = plan_storage_targets(
        _compute_capture_candidates(data_dir),
        n_configured=n_configured,
        heatmap_candidates=_compute_heatmap_codes(data_dir),
        kiwoom_enabled=settings.kiwoom_enabled,
        kiwoom_capacity=KIWOOM_PER_ACCOUNT_MAX * n_kiwoom,
    )

    # 프로그램매매 사이드카(호가 아님 — 별도 데이터 계열). bypass는 KIS REST 전면
    # 우회 토글이라 함께 끈다.
    program_trade_allowed = settings.program_trade_storage_enabled and not bypass
    program_collector = (
        _ensure_program_trade_collector(
            state,
            data_dir=data_dir,
            date_fn=date_fn,
            now_ms_fn=now_ms_fn,
        )
        if program_trade_allowed
        else state.program_trade_collector
    )
    if program_collector is not None:
        if program_trade_allowed:
            program_collector.start()
        else:
            await program_collector.stop()

    # 키움 WS 세션(ADR-0116) — 히트맵의 유일한 저장 경로. off/앱키0/타깃 비면
    # sync가 conn 0으로 정합화(휴면). 예외 격리(리뷰 Major): 키움 sync 오류가 이
    # 함수를 뚫고 나가 KIS 경로(session.refresh 등 호출자 후속)를 죽이면 안 된다.
    if settings.kiwoom_enabled and n_kiwoom > 0:
        kiwoom_mgr = _ensure_kiwoom_session(
            state, data_dir=data_dir, buffer=buffer,
            date_fn=date_fn, now_ms_fn=now_ms_fn,
        )
        try:
            await kiwoom_mgr.sync(targets.kiwoom_targets, n_accounts=n_kiwoom)
        except Exception:  # noqa: BLE001 — 키움 실패가 KIS 경로를 오염시키지 않게 격리
            log.warning("live.kiwoom.session_sync_failed", exc_info=True)
    elif state.kiwoom_session is not None:
        await state.kiwoom_session.stop()

    return StorageRuntimeSnapshot(
        ws_targets=targets.ws_targets,
        kiwoom_targets=targets.kiwoom_targets,
    )


async def stop_storage_runtime(state: StorageRuntimeState) -> None:
    collector = state.program_trade_collector
    if collector is not None:
        await collector.stop()
    kiwoom = state.kiwoom_session
    if kiwoom is not None:
        await kiwoom.stop()
