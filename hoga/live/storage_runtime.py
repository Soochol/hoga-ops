"""Apply Live Storage Policy to WS and KIS API capture runtimes."""

from __future__ import annotations

import logging
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from hoga.api.models import LiveStoragePolicy

log = logging.getLogger(__name__)

from . import kis_runtime
from .buffer import LiveBuffer
from .coverage import (
    KIWOOM_PER_ACCOUNT_MAX,
    LiveStorageTargets,
    _compute_capture_candidates,
    _compute_heatmap_rest_extras,
    plan_storage_targets,
)
from .kis_capacity_runtime import ensure_kis_capacity_scheduler
from .live_rest_capture_access import ScheduledLiveRestCaptureClient
from .settings import load_live_settings


# rest30 동시 디스패치 상한 — 계정(앱키)당 슬롯 수 (ADR-0100 계정 비례화, ADR-0102).
# ADR-0098: 단일 15/s 버킷 포화에 필요한 in-flight ≈ rate×latency ≈ 8, 기본 10(여유 2).
# 버킷이 앱키별 독립(ADR-0100)이라 aggregate 예산(~15/s×계정수)을 포화시키려면 슬롯도
# 계정 수에 비례해야 한다 — 3계정=30, 4계정=40. 이게 500종목@10초의 유일한 전제
# (4앱키 ~53/s → 500콜 ~9.4초 → 10초 경계 정착, ADR-0102). 상한 48은 httpx/스케줄러
# 여유 안. 실제 콜레이트는 계정별 버킷이 클램프하므로 과플러딩 없음.
_REST30_CONCURRENCY_PER_ACCOUNT = 10
_REST30_CONCURRENCY_MAX = 48


def _rest30_concurrency(data_dir: Path) -> int:
    """계정 수 비례 rest30 동시 상한 (ADR-0102). 1계정 10 → 3계정 30 → 4계정 40 →
    상한 48. 계정 수는 REST 예산의 배수라 그대로 in-flight 배수로 쓴다."""
    n_accounts = len(kis_runtime.configured_account_ids(data_dir))
    return min(_REST30_CONCURRENCY_PER_ACCOUNT * max(1, n_accounts), _REST30_CONCURRENCY_MAX)


class Rest30RecorderLike(Protocol):
    def set_targets(self, codes: set[str]) -> None: ...
    def start(self) -> None: ...
    async def stop(self) -> None: ...


class ProgramTradeCollectorLike(Protocol):
    def start(self) -> None: ...
    async def stop(self) -> None: ...


class KiwoomSessionLike(Protocol):
    async def sync(self, kiwoom_targets: tuple[str, ...], *, n_accounts: int) -> None: ...
    def active_codes(self) -> list[str]: ...
    def status(self) -> dict: ...
    async def stop(self) -> None: ...


class StorageRuntimeState(Protocol):
    rest30_recorder: Rest30RecorderLike | None
    program_trade_collector: ProgramTradeCollectorLike | None
    kiwoom_session: KiwoomSessionLike | None
    storage_policy: LiveStoragePolicy


@dataclass(frozen=True, slots=True)
class StorageRuntimeSnapshot:
    storage_policy: LiveStoragePolicy
    ws_targets: tuple[str, ...]
    kis_api_targets: tuple[str, ...]
    # 키움 WS 수집 대상(ADR-0116). lifecycle이 SignalAlertMonitor 타깃 합집합에 쓴다.
    kiwoom_targets: tuple[str, ...] = ()


def _ensure_rest30_recorder(
    state: StorageRuntimeState,
    *,
    data_dir: Path,
    buffer: LiveBuffer,
    date_fn: Callable[[], str],
    now_ms_fn: Callable[[], int],
) -> Rest30RecorderLike | None:
    from .rest30_recorder import Rest30sRecorder  # noqa: PLC0415

    if state.rest30_recorder is not None:
        return state.rest30_recorder
    if kis_runtime.ensure_kis_client_from_env(data_dir) is None:
        return None
    capture_client = ScheduledLiveRestCaptureClient(
        data_dir=data_dir,
        scheduler=ensure_kis_capacity_scheduler(data_dir),
        source="live-rest30-recorder",
    )
    recorder = Rest30sRecorder(
        kis_resolver=lambda: capture_client,
        buffer=buffer,
        data_dir=data_dir,
        date_fn=date_fn,
        phase_fn=lambda: __import__(
            "hoga.live.session_gate", fromlist=["market_phase"],
        ).market_phase(now_ms_fn()),
        # 수집 주기 = 사이클 소요 + interval. 히트맵 종목이 REST-전용 후보로 합류(ADR-0097)
        # 하면서 스냅샷 밀도를 30→10초로 높인다. REST 예산은 계정별 15/s 버킷(kis_runtime,
        # ADR-0100 — 계정 수에 비례 증설)이 상한을 지키고 background 우선순위라 사용자 요청에
        # 양보한다. concurrency도 계정 비례(ADR-0102) — 예산을 다 쓰려면 in-flight가 계정 수에
        # 비례해야 한다. 500종목@10초는 4앱키(~53/s)에서 사이클 ~9.4초 → 10초 경계 정착
        # (3앱키는 ~12.5초라 ~20초 실효; 사이클이 interval 초과 시 다음 경계로 정렬). 진행은
        # kis_api_last_cycle_ms 로 관측. 클래스/파일/로그의 'rest30' 이름은 표면 안정을 위해
        # 유지한다. 부수효과: 에러 백오프는 cycle 단위(recorder.backoff_cycles=3)라 wall-time 이
        # 90→30초로 짧아진다 — EGW00201 스톰 시 재시도가 3배 잦아지나, 계정별 15/s 버킷과
        # FM5 auth latch 가 상한을 지키므로 안전(오히려 복구가 빠르다).
        concurrency=_rest30_concurrency(data_dir),
        interval_s=10.0,
    )
    state.rest30_recorder = recorder
    return recorder


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
    rest_fallback_codes: tuple[str, ...] = (),
) -> StorageRuntimeSnapshot:
    """Load settings, plan targets, and sync the persisted REST 30s runtime.

    rest_fallback_codes: WS 구독 사다리 소진 종목의 REST 임시 편입(해결안 ③) —
    lifecycle의 watchdog이 소유하는 폴백 집합을 관통시킨다. bypass 시엔 REST
    저장 전체가 꺼지므로 폴백도 함께 드롭된다."""
    settings = load_live_settings(data_dir)
    bypass = settings.kis_rest_bypass_enabled
    state.storage_policy = settings.storage_policy
    if n_configured is None:
        n_configured = len(kis_runtime.configured_account_ids(data_dir))
    heatmap_extras = (
        _compute_heatmap_rest_extras(data_dir)
        if settings.heatmap_capture_enabled
        else ()
    )
    # 키움 실수용량으로 히트맵 라우팅을 게이트(리뷰 Major): 앱키 0이면 KIS REST 유지,
    # 200×앱키수 초과분은 KIS로 되돌려 어디서도 수집 안 되는 구멍을 막는다.
    from . import kiwoom_runtime  # noqa: PLC0415
    n_kiwoom = len(kiwoom_runtime.configured_account_ids(data_dir))
    kiwoom_capacity = KIWOOM_PER_ACCOUNT_MAX * n_kiwoom
    targets = plan_storage_targets(
        _compute_capture_candidates(data_dir),
        n_configured=n_configured,
        storage_policy=settings.storage_policy,
        rest_extra_candidates=heatmap_extras,
        rest_fallback_codes=rest_fallback_codes,
        kiwoom_enabled=settings.kiwoom_enabled,
        kiwoom_capacity=kiwoom_capacity,
    )
    if bypass:
        targets = LiveStorageTargets(
            ws_targets=targets.ws_targets,
            kis_api_targets=(),
            capture_candidates=targets.capture_candidates,
            kiwoom_targets=targets.kiwoom_targets,  # bypass는 KIS REST만 끔 — 키움 무관
        )
    recorder = (
        _ensure_rest30_recorder(
            state,
            data_dir=data_dir,
            buffer=buffer,
            date_fn=date_fn,
            now_ms_fn=now_ms_fn,
        )
        if targets.kis_api_targets
        else state.rest30_recorder
    )
    if recorder is not None:
        recorder.set_targets(set(targets.kis_api_targets))
        if targets.kis_api_targets:
            recorder.start()
        else:
            await recorder.stop()

    program_trade_allowed = (
        settings.program_trade_storage_enabled
        and settings.storage_policy != "ws_only"
        and not bypass
    )
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

    # 키움 WS 세션(ADR-0116) — 히트맵을 KIS REST30 대신 키움 WS로. off/앱키0/타깃 비면
    # sync가 conn 0으로 정합화(휴면). 예외 격리(리뷰 Major): 키움 sync 오류가 이 함수를
    # 뚫고 나가 KIS 경로(session.refresh 등 호출자 후속)를 죽이면 안 된다.
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
        storage_policy=settings.storage_policy,
        ws_targets=targets.ws_targets,
        kis_api_targets=targets.kis_api_targets,
        kiwoom_targets=targets.kiwoom_targets,
    )


async def stop_storage_runtime(state: StorageRuntimeState) -> None:
    recorder = state.rest30_recorder
    if recorder is not None:
        await recorder.stop()
    collector = state.program_trade_collector
    if collector is not None:
        await collector.stop()
    kiwoom = state.kiwoom_session
    if kiwoom is not None:
        await kiwoom.stop()
