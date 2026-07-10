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
from dataclasses import dataclass
from typing import Protocol, runtime_checkable

from .buffer import LiveBuffer
from .error_policy import classify_live_error, format_live_error
from .kis_models import KisBrokers, KisOrderbook, KisTrade
from .rest_buffer_build import brokers_to_snapshot, ob_to_snapshot, trades_to_snapshots
from .session_gate import market_phase, target_ws_venue, ws_connection_window

_log = logging.getLogger(__name__)


def _now_ms() -> int:
    return int(time.time() * 1000)


@dataclass(frozen=True)
class LiveRestPollerStatus:
    running: bool
    target_count: int
    targets: tuple[str, ...]
    last_cycle_ms: int | None
    last_error: str | None
    last_error_kind: str | None
    last_error_code: str | None
    last_error_count: int
    degraded: bool
    backoff_remaining: int


@runtime_checkable
class _KisRestProto(Protocol):
    """최소 프로토콜 — LiveRestPoller가 KisClient에서 쓰는 메서드만 정의.

    KisClient도 FakeKisClient도 이 구조적 타입을 만족하므로 테스트에서
    fake를 주입할 수 있고 프로덕션에서 KisClient 실체를 주입할 수 있다.
    """

    async def fetch_orderbook(
        self, code: str, *, venue: str = "KRX"
    ) -> KisOrderbook: ...
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
        kis_resolver: Callable[[], _KisRestProto | None],
        buffer: LiveBuffer,
        *,
        interval_s: float = 2.0,
        phase_fn: Callable[[], str] | None = None,
        window_fn: Callable[[], bool] | None = None,
        venue_fn: Callable[[], str] | None = None,
        capture_aux: bool = False,
    ) -> None:
        # 고정 client가 아니라 resolver를 받는다. 운영에서는 scheduler-backed proxy를,
        # 테스트에서는 lambda: fake를 주입할 수 있다. None을 반환하면(creds 소실 등)
        # 그 사이클을 우아하게 skip한다.
        self._resolve_kis = kis_resolver
        self._buffer = buffer
        self._interval_s = interval_s
        self._phase_fn = phase_fn or (lambda: market_phase(_now_ms()))
        # 활성 창(거래일 08:00–20:00) 판정과 시분할 venue(ADR-0099, WS #524 미러).
        # window_fn은 캘린더 캐시 미스 시 동기 KIS HTTP 가능(session_gate blocking
        # 계약) — _poll_once가 to_thread로 봉인한다(KisWsClient gate_fn 패턴).
        # venue_fn은 순수 시계(08:50–15:31 KRX, 그 외 NXT).
        self._window_fn = window_fn or (lambda: ws_connection_window(_now_ms()))
        self._venue_fn = venue_fn or (lambda: target_ws_venue(_now_ms()))
        # False = 10호가(orderbook)만 폴링/표시(REST 호가 통일, ADR-0098). True면
        # 기존 호가+체결+거래원 3콜 복원. 체결·거래원 실시간은 WS(관심종목) 전용.
        self._capture_aux = capture_aux

        self._subscribed: set[str] = set()
        self._excluded: set[str] = set()
        # 장 마감(phase=='closed') 중 1회 종가 스냅샷을 이미 받은 종목 — 마감엔
        # 시세가 불변이라 반복 폴링이 무의미(KIS 쿼터 낭비). 재개장 시 비워 정상 복원.
        self._snapshotted_once: set[str] = set()

        self._task: asyncio.Task | None = None  # type: ignore[type-arg]
        self.last_cycle_ms: int | None = None
        self._last_error: str | None = None
        self._last_error_kind: str | None = None
        self._last_error_code: str | None = None
        self._last_error_count = 0
        self._degraded = False
        self._backoff_remaining = 0

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

    def status(self) -> LiveRestPollerStatus:
        targets = self._subscribed - self._excluded
        return LiveRestPollerStatus(
            running=self.alive,
            target_count=len(targets),
            targets=tuple(sorted(targets)),
            last_cycle_ms=self.last_cycle_ms,
            last_error=self._last_error,
            last_error_kind=self._last_error_kind,
            last_error_code=self._last_error_code,
            last_error_count=self._last_error_count,
            degraded=self._degraded,
            backoff_remaining=self._backoff_remaining,
        )

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
            except Exception as e:  # noqa: BLE001 — 사이클 전체 예외 격리
                self._record_cycle_error(e)
            await asyncio.sleep(self._interval_s)

    async def _poll_once(self) -> None:
        """한 사이클: (subscribed - excluded) 각 종목 fetch → B3 변환 → buffer.publish.

        각 종목 처리를 try/except로 감싸 한 실패가 다른 종목 처리를 막지 않게 함.
        last_cycle_ms는 사이클 완료 후 갱신 (ADR-0064: 성공 신호, finally 아님).
        """
        if self._backoff_remaining > 0:
            self._backoff_remaining -= 1
            self.last_cycle_ms = _now_ms()
            return

        # 사이클 시작 시 resolver에서 KIS REST adapter를 얻는다. None이면(creds 소실 등)
        # 이 사이클은 폴링 불가 -> 우아하게 skip(다음 사이클 재시도).
        kis = self._resolve_kis()
        if kis is None:
            self.last_cycle_ms = _now_ms()  # 사이클은 정상 완료(폴링할 client 부재일 뿐)
            return

        # 사이클 시작 시 target 스냅샷 — await 중 외부 변경이 안전하도록
        targets = self._subscribed - self._excluded

        # 활성 창 게이트(ADR-0099, WS #524 미러): 연결 창(거래일 08:00–20:00) 안이면
        # 매 사이클 폴링 + 시분할 venue(08:50–15:31 KRX, 그 외 NXT). 창 밖이면 기존
        # 장 마감 게이트(ADR-0067)를 유지 — phase=='closed'면 시세 불변이라 아직 안
        # 받은 종목만 1회 종가 스냅샷 후 skip, regular/장전이면 표식을 비워 주기 폴링 복원.
        # window_fn은 캘린더 캐시 미스 시 동기 KIS HTTP 가능 → to_thread 봉인
        # (session_gate blocking 계약). 예외는 _run_loop 사이클 격리가 흡수.
        # venue_fn/phase_fn은 사이클마다 호출(프레시) — 경계 전환은 다음 사이클 반영.
        in_window = await asyncio.to_thread(self._window_fn)
        venue = self._venue_fn() if in_window else "KRX"
        closed = (not in_window) and self._phase_fn() == "closed"
        if closed:
            targets = targets - self._snapshotted_once
        else:
            self._snapshotted_once.clear()

        error_count = 0
        last_error: str | None = None
        last_error_kind: str | None = None
        last_error_code: str | None = None

        for code in sorted(targets):
            try:
                await self._fetch_and_publish(code, kis, venue=venue)
                # 성공한 종목만 1회-표식에 추가(실패는 다음 사이클 재시도).
                if closed:
                    self._snapshotted_once.add(code)
            except Exception as e:  # noqa: BLE001 — 종목별 격리
                policy = classify_live_error(e)
                error_count += 1
                last_error = format_live_error(e)
                last_error_kind = policy.kind
                last_error_code = policy.code
                self._backoff_remaining = max(self._backoff_remaining, policy.backoff_cycles)
                log_msg = "live.rest_poller.code_failed code=%s kind=%s error=%s"
                if policy.include_traceback:
                    _log.error(log_msg, code, policy.kind, policy.code, exc_info=True)
                else:
                    _log.warning(log_msg, code, policy.kind, policy.code)

        self._last_error_count = error_count
        if error_count == 0:
            self._last_error = None
            self._last_error_kind = None
            self._last_error_code = None
            self._degraded = False
        else:
            self._last_error = last_error
            self._last_error_kind = last_error_kind
            self._last_error_code = last_error_code
            self._degraded = True

        # 사이클이 정상 완료됐음을 기록 (stall 감지용 신호)
        self.last_cycle_ms = _now_ms()

    def _record_cycle_error(self, exc: Exception) -> None:
        policy = classify_live_error(exc, internal=True)
        self._last_error = format_live_error(exc)
        self._last_error_kind = policy.kind
        self._last_error_code = policy.code
        self._last_error_count = 1
        self._degraded = policy.degraded
        self._backoff_remaining = max(self._backoff_remaining, policy.backoff_cycles)
        log_msg = "live.rest_poller.cycle_failed kind=%s error=%s"
        if policy.include_traceback:
            _log.error(log_msg, policy.kind, policy.code, exc_info=True)
        else:
            _log.warning(log_msg, policy.kind, policy.code)

    async def _fetch_and_publish(
        self, code: str, kis: _KisRestProto, *, venue: str = "KRX"
    ) -> None:
        """단일 종목: fetch → B3 변환 → buffer.publish.

        기본은 10호가(orderbook)만(REST 호가 통일, ADR-0098). capture_aux=True일 때만
        체결·거래원 3콜을 복원한다. 체결·거래원 실시간은 WS(관심종목) 전용이라,
        REST 전용(히트맵) 종목은 보는 중에도 호가/총잔량만 갱신된다.

        venue(ADR-0099)는 시분할 표시폴러용 — 호가만 시분할하고 스냅샷에 태그를 실어
        프론트 venue 매칭이 WS와 동일하게 동작하게 한다. capture_aux(체결·거래원)는
        venue 미전달(KRX 전용 유지, 비범위).

        kis는 _poll_once가 사이클 시작에 resolve한 KIS REST adapter다. scheduler-backed
        proxy일 수도 있고 테스트 fake일 수도 있다.
        - 저장 함수(writer.append / promote / to_jsonl) 절대 불호출.
        - now_ms를 한 번 계산해 brokers_to_snapshot(now_ms=...) + publish(now_ms=...) 공유.
        """
        now_ms = _now_ms()
        phase = self._phase_fn()

        ob = await kis.fetch_orderbook(code, venue=venue)
        snaps = [ob_to_snapshot(ob, phase=phase, venue=venue)]
        if self._capture_aux:
            trades = await kis.fetch_trades(code)
            brokers = await kis.fetch_brokers(code)
            snaps += [
                *trades_to_snapshots(trades, phase=phase),
                brokers_to_snapshot(brokers, now_ms=now_ms, phase=phase),
            ]
        await self._buffer.publish(code, snaps, now_ms=now_ms)
