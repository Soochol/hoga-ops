"""Apply Live storage targets to the 키움 WS capture runtime + 프로그램 사이드카.

KIS REST 30s 캡처(ADR-0097 rest30)와 KIS WS 는 제거됐다(#678·ADR-0118 —
호가·체결·거래원·프로그램 전부 키움 전담). 이 모듈은 저장 타깃 계획과
키움 세션·프로그램매매 사이드카(0w latch drain)의 정합화를 담당한다.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from .buffer import LiveBuffer
from .coverage import (
    KIWOOM_PER_ACCOUNT_MAX,
    _compute_capture_candidates,
    _compute_heatmap_codes,
    plan_storage_targets,
)

log = logging.getLogger(__name__)


class ProgramTradeCollectorLike(Protocol):
    def start(self) -> None: ...
    async def stop(self) -> None: ...

    @property
    def task(self) -> asyncio.Task | None:
        """ADR-0088 liveness 판정용 태스크 핸들(lifecycle.get_program_trade_task)."""
        ...


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
    from .kiwoom_session import (  # noqa: PLC0415 — 지연 import(순환/heavy)
        KiwoomSessionManager,
    )
    from .session_gate import ws_connection_window  # noqa: PLC0415 — 지연 import(순환 절단·heavy 모듈·monkeypatch 시임)

    mgr = KiwoomSessionManager(
        buffer=buffer,
        data_dir=data_dir,
        date_fn=date_fn,
        gate_fn=lambda: ws_connection_window(now_ms_fn()),
        now_fn=now_ms_fn,  # 표시 장부 유예·재배정의 시각원(워치독과 공유)
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
    from .program_trade_collector import (  # noqa: PLC0415 — 지연 import(순환/heavy)
        ProgramTradeCollector,
    )

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
    from . import kiwoom_runtime  # noqa: PLC0415 — 지연 import(순환 절단·heavy 모듈·monkeypatch 시임)
    n_kiwoom = len(kiwoom_runtime.configured_account_ids(data_dir))
    capacity = KIWOOM_PER_ACCOUNT_MAX * n_kiwoom
    capture_candidates = _compute_capture_candidates(data_dir)
    heatmap_codes = _compute_heatmap_codes(data_dir)
    # capacity 는 **등록 수** 예산이다 — venue 동시 구독(ADR-0140 §2)에서 NXT 상장
    # 종목 하나가 등록 3개(KRX·NXT·UN)를 쓴다. 종목 수로 절단하면 예산의 3배를 배정하고
    # 키움이 계정당 200 에서 거부한다.
    from hoga.api import symbols as _symbols  # noqa: PLC0415 — 순환 절단

    from .coverage import venue_weight  # noqa: PLC0415 — 지연(위 kiwoom_runtime 과 같은 규율)

    nxt_map = _symbols.nxt_enabled_by_code()
    targets = plan_storage_targets(
        capture_candidates,
        heatmap_candidates=heatmap_codes,
        kiwoom_capacity=capacity,
        weight=lambda code: venue_weight(code, nxt_map),
    )
    # 확정 저장셋 크기를 매 sync 마다 남긴다 — 이 숫자는 키움 WS 슬롯 예산·디스크 용량
    # 산술의 입력이라 "지금 몇 종목을 수집 중인가"가 사후 확인 가능해야 한다. 초과분
    # 경고(plan_storage_targets)는 잘렸을 때만 뜨므로 정상 경로의 크기를 못 알려준다.
    log.info(
        "live.storage.targets watchlist=%d heatmap=%d kiwoom_targets=%d capacity=%d accounts=%d",
        len(capture_candidates), len(heatmap_codes),
        len(targets.kiwoom_targets), capacity, n_kiwoom,
    )

    # 프로그램매매 사이드카(호가 아님 — 별도 데이터 계열). 설정 스위치는 폐지
    # (2026-07-21) — PR-F4 로 소스가 키움 0w push 가 되면서 수집 한계비용이 0 이
    # 됐다(0w 는 DEFAULT_TYPES 라 토글과 무관하게 항상 구독되고, 키움 한도는 종목
    # 단위·타입 무관이라 슬롯도 무료). 옛 토글은 KIS REST 30s 폴링 시절 쿼터를
    # 아끼려던 잔재였고, 끄면 latch 만 쌓이고 아무도 drain 하지 않아 데이터가
    # 조용히 유실됐다 — 거래원(0F)이 스위치 없이 항시 저장되는 것과 같은 규율로
    # 맞춘다(키움 활성화 스위치 폐지 ADR-0118 과 동형).
    #
    # ⚠ **data_dir 당 한 프로세스만 drain 한다**(ADR-0094 확장). 워크트리 백엔드가
    # 메인 `.env` 를 상속해 뜨면 같은 사이드카 파일에 둘이 쓴다 — 수급 수집기에서
    # 2026-08-10 에 실측된 것과 같은 구조다. 락은 `today promoter` 와 공유한다
    # (`ws` — 둘 다 전제가 "살아 있는 키움 WS" 하나뿐이고, 앱키당 WS 1세션이라
    # 두 프로세스가 동시에 건강할 수 없어 판정이 늘 같이 간다).
    #
    # `n_kiwoom > 0` 을 자격 게이트로 쓴다: 키움이 없으면 latch 가 비어 drain 할
    # 것도 없는데, 락만 선점하면 나중에 뜬 자격 있는 인스턴스가 저장을 못 한다.
    from hoga.api import ownership  # noqa: PLC0415 — 지연 import(순환 절단: api ← live)

    if ownership.acquire("ws", data_dir, available=n_kiwoom > 0):
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
