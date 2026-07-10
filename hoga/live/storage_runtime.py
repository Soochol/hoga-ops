"""Apply Live Storage Policy to WS and KIS API capture runtimes."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from hoga.api.models import LiveStoragePolicy

from . import kis_runtime
from .buffer import LiveBuffer
from .coverage import (
    LiveStorageTargets,
    _compute_capture_candidates,
    _compute_heatmap_rest_extras,
    plan_storage_targets,
)
from .kis_capacity_runtime import ensure_kis_capacity_scheduler
from .live_rest_capture_access import ScheduledLiveRestCaptureClient
from .settings import load_live_settings


class Rest30RecorderLike(Protocol):
    def set_targets(self, codes: set[str]) -> None: ...
    def start(self) -> None: ...
    async def stop(self) -> None: ...


class ProgramTradeCollectorLike(Protocol):
    def start(self) -> None: ...
    async def stop(self) -> None: ...


class StorageRuntimeState(Protocol):
    rest30_recorder: Rest30RecorderLike | None
    program_trade_collector: ProgramTradeCollectorLike | None
    storage_policy: LiveStoragePolicy


@dataclass(frozen=True, slots=True)
class StorageRuntimeSnapshot:
    storage_policy: LiveStoragePolicy
    ws_targets: tuple[str, ...]
    kis_api_targets: tuple[str, ...]


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
        # 양보한다. 대상 수가 커지면 사이클이 길어져 실제 주기는 자연히 늘어난다(적응형 여부는
        # 실장 후 kis_api_last_cycle_ms 로 판단). 클래스/파일/로그의 'rest30' 이름은 표면
        # 안정을 위해 유지한다. 부수효과: 에러 백오프는 cycle 단위(recorder.backoff_cycles=3)라
        # wall-time 이 90→30초로 짧아진다 — EGW00201 스톰 시 재시도가 3배 잦아지나, 계정별
        # 15/s 버킷과 FM5 auth latch 가 상한을 지키므로 안전(오히려 복구가 빠르다).
        interval_s=10.0,
    )
    state.rest30_recorder = recorder
    return recorder


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
    """Load settings, plan targets, and sync the persisted REST 30s runtime."""
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
    targets = plan_storage_targets(
        _compute_capture_candidates(data_dir),
        n_configured=n_configured,
        storage_policy=settings.storage_policy,
        rest_extra_candidates=heatmap_extras,
    )
    if bypass:
        targets = LiveStorageTargets(
            ws_targets=targets.ws_targets,
            kis_api_targets=(),
            capture_candidates=targets.capture_candidates,
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
    return StorageRuntimeSnapshot(
        storage_policy=settings.storage_policy,
        ws_targets=targets.ws_targets,
        kis_api_targets=targets.kis_api_targets,
    )


async def stop_storage_runtime(state: StorageRuntimeState) -> None:
    recorder = state.rest30_recorder
    if recorder is not None:
        await recorder.stop()
    collector = state.program_trade_collector
    if collector is not None:
        await collector.stop()
