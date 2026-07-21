"""Apply Live storage targets to the 키움 WS capture runtime + 프로그램 사이드카.

KIS REST 30s 캡처(ADR-0097 rest30)와 KIS WS 는 제거됐다(#678·ADR-0118 —
호가·체결·거래원·프로그램 전부 키움 전담). 이 모듈은 저장 타깃 계획과
키움 세션·프로그램매매 사이드카(0w latch drain)의 정합화를 담당한다.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

log = logging.getLogger(__name__)

from .coverage import (
    KIWOOM_PER_ACCOUNT_MAX,
    _compute_capture_candidates,
    _compute_heatmap_codes,
    plan_storage_targets,
)
from .buffer import LiveBuffer


class ProgramTradeCollectorLike(Protocol):
    def start(self) -> None: ...
    async def stop(self) -> None: ...


class KiwoomSessionLike(Protocol):
    async def sync(self, kiwoom_targets: tuple[str, ...], *, n_accounts: int) -> None: ...
    async def watchdog_pass(self, now_ms: int) -> None: ...
    async def on_view_subscribe(self, code: str, venues: set[str], *, ref: str) -> bool: ...
    async def on_view_unsubscribe(self, code: str, venues: set[str], *, ref: str) -> None: ...
    def capture_streams(self) -> list[object]: ...
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
    # 관심종목(슬롯/용량 무관 전체). 거래원 폴러(PR-F2 삭제)의 타깃 소스였고,
    # 현재 소비처는 watchlist_projection(수집 후보 판정)뿐.
    capture_candidates: tuple[str, ...] = ()


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
) -> StorageRuntimeSnapshot:
    """Plan targets and sync the WS capture runtimes."""
    from . import kiwoom_runtime  # noqa: PLC0415
    n_kiwoom = len(kiwoom_runtime.configured_account_ids(data_dir))
    targets = plan_storage_targets(
        _compute_capture_candidates(data_dir),
        heatmap_candidates=_compute_heatmap_codes(data_dir),
        kiwoom_capacity=KIWOOM_PER_ACCOUNT_MAX * n_kiwoom,
    )

    # 프로그램매매 사이드카(호가 아님 — 별도 데이터 계열). 설정 스위치는 폐지
    # (2026-07-21) — PR-F4 로 소스가 키움 0w push 가 되면서 수집 한계비용이 0 이
    # 됐다(0w 는 DEFAULT_TYPES 라 토글과 무관하게 항상 구독되고, 키움 한도는 종목
    # 단위·타입 무관이라 슬롯도 무료). 옛 토글은 KIS REST 30s 폴링 시절 쿼터를
    # 아끼려던 잔재였고, 끄면 latch 만 쌓이고 아무도 drain 하지 않아 데이터가
    # 조용히 유실됐다 — 거래원(0F)이 스위치 없이 항시 저장되는 것과 같은 규율로
    # 맞춘다(키움 활성화 스위치 폐지 ADR-0118 과 동형).
    program_collector = _ensure_program_trade_collector(
        state,
        data_dir=data_dir,
        date_fn=date_fn,
        now_ms_fn=now_ms_fn,
    )
    program_collector.start()

    # 키움 WS 세션(ADR-0116) — 실시간(호가·체결)의 유일한 소스. 활성화 스위치는 폐지
    # (ADR-0118) — 자격증명(앱키)만 있으면 항상 활성. 앱키0/타깃 비면 sync가 conn 0으로
    # 정합화(휴면). 예외 격리(리뷰 Major): 키움 sync 오류가 이 함수를 뚫고 나가 KIS
    # 경로(session.refresh 등 호출자 후속)를 죽이면 안 된다.
    if n_kiwoom > 0:
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
        capture_candidates=targets.capture_candidates,
    )


async def stop_storage_runtime(state: StorageRuntimeState) -> None:
    collector = state.program_trade_collector
    if collector is not None:
        await collector.stop()
    kiwoom = state.kiwoom_session
    if kiwoom is not None:
        await kiwoom.stop()
