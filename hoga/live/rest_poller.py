"""LiveRestPoller — 보는종목(activeCode) REST 표시폴러 (ADR-0067).

관심종목 밖에서 사용자가 보는 종목을 2초 주기 REST 폴링 → LiveBuffer.publish.
디스크 저장 절대 금지 — 저장은 WS 경로 전용 (ADR-0067 필수).

ADR-0064 교훈 (침묵 사망 재발 방지):
- 폴링 루프를 try/except로 격리 — 한 종목 실패나 사이클 raise가 태스크 전체를
  죽이지 않게 (로그 후 계속).
- alive는 task.done() 기반 — 내부 플래그 위조 금지(거짓 health 보고 금지).
- last_cycle_ms: 사이클 완료 시각 (stall 감지용; 사이클이 돌지 않으면 None 유지).

배타: set_excluded_codes로 받은 WS live_set 종목은 폴링에서 skip.
"""
from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Callable
from typing import Protocol, runtime_checkable

from .buffer import LiveBuffer
from .kis_models import KisBrokers, KisOrderbook, KisTrade
from .rest_buffer_build import brokers_to_snapshot, ob_to_snapshot, trades_to_snapshots
from .session_gate import market_phase

_log = logging.getLogger(__name__)


def _now_ms() -> int:
    return int(time.time() * 1000)


@runtime_checkable
class _KisRestProto(Protocol):
    """최소 프로토콜 — LiveRestPoller가 KisClient에서 쓰는 메서드만 정의.

    KisClient도 FakeKisClient도 이 구조적 타입을 만족하므로 테스트에서
    fake를 주입할 수 있고 프로덕션에서 KisClient 실체를 주입할 수 있다.
    """

    async def fetch_orderbook(self, code: str) -> KisOrderbook: ...
    async def fetch_trades(self, code: str) -> list[KisTrade]: ...
    async def fetch_brokers(self, code: str) -> KisBrokers: ...


class LiveRestPoller:
    """REST 폴러 — activeCode가 WS live_set 밖이면 REST로 시세 표시.

    start() / stop() : asyncio task 생명주기.
    on_subscribe(code) / on_unsubscribe(code) : 폴링 대상 관리.
    set_excluded_codes(codes) : WS-active 종목 배타 skip.
    alive : task 생사 상태 (task.done() 기반, ADR-0064).
    last_cycle_ms : 마지막 사이클 완료 epoch-ms (stall 감지).
    """

    def __init__(
        self,
        kis: _KisRestProto,
        buffer: LiveBuffer,
        *,
        interval_s: float = 2.0,
        phase_fn: Callable[[], str] | None = None,
    ) -> None:
        self._kis: _KisRestProto = kis
        self._buffer = buffer
        self._interval_s = interval_s
        self._phase_fn = phase_fn or (lambda: market_phase(_now_ms()))

        self._subscribed: set[str] = set()
        self._excluded: set[str] = set()
        # 장 마감(phase=='closed') 중 1회 종가 스냅샷을 이미 받은 종목 — 마감엔
        # 시세가 불변이라 반복 폴링이 무의미(KIS 쿼터 낭비). 재개장 시 비워 정상 복원.
        self._snapshotted_once: set[str] = set()

        self._task: asyncio.Task | None = None  # type: ignore[type-arg]
        self.last_cycle_ms: int | None = None

    # ── Public interface ───────────────────────────────────────────────────────

    def on_subscribe(self, code: str) -> None:
        """폴링 대상에 추가."""
        self._subscribed.add(code)

    def on_unsubscribe(self, code: str) -> None:
        """폴링 대상에서 제거."""
        self._subscribed.discard(code)
        # 재구독 시(마감 중이라도) 새 1회 스냅샷을 받도록 표식 제거.
        self._snapshotted_once.discard(code)

    def set_excluded_codes(self, codes: set[str]) -> None:
        """WS live_set(수집 중) 종목 — 폴링에서 배타 skip."""
        self._excluded = set(codes)

    @property
    def alive(self) -> bool:
        """태스크가 살아있으면 True (ADR-0064: task.done() 기반, 플래그 위조 금지)."""
        return self._task is not None and not self._task.done()

    def start(self) -> None:
        """폴링 루프 asyncio task 시작."""
        if self._task is not None and not self._task.done():
            return  # 이미 실행 중
        self._task = asyncio.create_task(self._run_loop(), name="live-rest-poller")

    async def stop(self) -> None:
        """폴링 태스크 취소 + 정리 (stop_today_promoter 패턴 복사)."""
        if self._task is None or self._task.done():
            return
        self._task.cancel()
        try:
            await self._task
        except asyncio.CancelledError:
            pass

    # ── Internal ───────────────────────────────────────────────────────────────

    async def _run_loop(self) -> None:
        """폴링 루프 — 매 interval_s마다 _poll_once 실행.

        ADR-0064 이중 격리:
        - 외부 try/except: 사이클 전체가 raise해도 루프가 죽지 않음.
        - 내부(_poll_once): 종목별 try/except (fetch/convert/publish 실패 격리).
        sleep은 격리 바깥 — CancelledError가 정상 종료 경로.
        """
        while True:
            try:
                await self._poll_once()
            except Exception:  # noqa: BLE001 — 사이클 전체 예외 격리
                _log.exception("live.rest_poller.cycle_failed")
            await asyncio.sleep(self._interval_s)

    async def _poll_once(self) -> None:
        """한 사이클: (subscribed - excluded) 각 종목 fetch → B3 변환 → buffer.publish.

        각 종목 처리를 try/except로 감싸 한 실패가 다른 종목 처리를 막지 않게 함.
        last_cycle_ms는 사이클 완료 후 갱신 (ADR-0064: 성공 신호, finally 아님).
        """
        # 사이클 시작 시 target 스냅샷 — await 중 외부 변경이 안전하도록
        targets = self._subscribed - self._excluded

        # 장 마감 게이트(ADR-0067 후속, 2026-06-09): phase=='closed'면 시세가
        # 불변이라 반복 폴링이 KIS 쿼터만 낭비한다. 아직 스냅샷 안 받은 종목만
        # 1회 받아 마지막(종가) 상태를 표시하고, 그 외는 skip. 정규장/장전이면
        # 표식을 비워 모든 종목이 다시 주기 폴링되도록 복원한다.
        # phase_fn은 사이클마다 호출(프레시) — 15:30 경계 전환은 다음 사이클에 반영.
        closed = self._phase_fn() == "closed"
        if closed:
            targets = targets - self._snapshotted_once
        else:
            self._snapshotted_once.clear()

        for code in targets:
            try:
                await self._fetch_and_publish(code)
                # 성공한 종목만 1회-표식에 추가(실패는 다음 사이클 재시도).
                if closed:
                    self._snapshotted_once.add(code)
            except Exception:  # noqa: BLE001 — 종목별 격리
                _log.exception("live.rest_poller.code_failed code=%s", code)

        # 사이클이 정상 완료됐음을 기록 (stall 감지용 신호)
        self.last_cycle_ms = _now_ms()

    async def _fetch_and_publish(self, code: str) -> None:
        """단일 종목: fetch_* 3개 → B3 변환 → buffer.publish.

        - 저장 함수(writer.append / promote / to_jsonl) 절대 불호출.
        - now_ms를 한 번 계산해 brokers_to_snapshot(now_ms=...) + publish(now_ms=...) 공유.
        """
        now_ms = _now_ms()
        phase = self._phase_fn()

        ob = await self._kis.fetch_orderbook(code)
        trades = await self._kis.fetch_trades(code)
        brokers = await self._kis.fetch_brokers(code)

        ob_snap = ob_to_snapshot(ob, phase=phase)
        trade_snaps = trades_to_snapshots(trades, phase=phase)
        broker_snap = brokers_to_snapshot(brokers, now_ms=now_ms, phase=phase)

        all_snaps = [ob_snap, *trade_snaps, broker_snap]
        await self._buffer.publish(code, all_snaps, now_ms=now_ms)
