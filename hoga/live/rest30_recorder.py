"""Persisted 30-second KIS REST recorder for capture-enabled watchlist targets."""
from __future__ import annotations

import asyncio
import logging
import time
from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol, runtime_checkable

from hoga.live.buffer import LiveBuffer
from hoga.live.error_policy import classify_live_error, format_live_error
from hoga.live.kis_models import KisBrokers, KisOrderbook, KisTrade
from hoga.live.lifecycle import get_signal_alert_monitor
from hoga.live.rest30_writer import make_rest30_writer
from hoga.live.rest_buffer_build import brokers_to_snapshot, ob_to_snapshot, trades_to_snapshots

_log = logging.getLogger(__name__)


@runtime_checkable
class KisRestCaptureProto(Protocol):
    async def fetch_orderbook(self, code: str) -> KisOrderbook: ...
    async def fetch_trades(self, code: str) -> list[KisTrade]: ...
    async def fetch_brokers(self, code: str) -> KisBrokers: ...


@dataclass(frozen=True)
class Rest30sStatus:
    running: bool
    target_count: int
    targets: tuple[str, ...]
    last_cycle_ms: int | None
    last_error: str | None
    last_error_count: int
    degraded: bool
    last_error_kind: str | None = None
    last_error_code: str | None = None
    backoff_remaining: int = 0
    last_cycle_duration_ms: int | None = None


class Rest30sRecorder:
    def __init__(
        self,
        *,
        kis_resolver: Callable[[], KisRestCaptureProto | None],
        buffer: LiveBuffer,
        data_dir: Path,
        date_fn: Callable[[], str],
        now_ms_fn: Callable[[], int] | None = None,
        phase_fn: Callable[[], str],
        trading_day_fn: Callable[[], bool] | None = None,
        interval_s: float = 30.0,
        backoff_cycles: int = 3,
        concurrency: int = 10,
        capture_aux: bool = False,
    ) -> None:
        self._resolve_kis = kis_resolver
        self._buffer = buffer
        self._writer = make_rest30_writer(data_dir)
        self._date_fn = date_fn
        self._now_ms = now_ms_fn or (lambda: int(time.time() * 1000))
        self._phase_fn = phase_fn
        # 거래일 게이트(ADR-0099 저장 파리티) — 비거래일엔 캡처/저장 금지. 기본값은
        # 실제 캘린더 술어(주말/휴장 배제), 테스트는 fake 주입(LiveRestPoller.window_fn
        # 패턴 미러). blocking 계약이라 poll_once가 asyncio.to_thread로 봉인한다.
        self._trading_day_fn = trading_day_fn or self._default_trading_day_fn
        self._interval_s = interval_s
        self._backoff_cycles = max(0, backoff_cycles)
        # 코드 간 동시 디스패치 상한(코드 내부는 순차). 실제 콜레이트는 계정별
        # 15콜/s 토큰버킷(합산 ~15×계정수, ADR-0100)이 클램프하므로, 이 값은 그 게이트를
        # 채우기에 충분한 in-flight 수(≈ rate×latency)면 된다 — 과하면 user_visible
        # 대기창만 커진다(ADR-0098). 3계정 포화용 재튜닝은 실장 관측 후 별도.
        self._concurrency = max(1, concurrency)
        # False = 10호가(orderbook)만 fetch/저장(REST 호가 통일, ADR-0098). True면
        # 기존 호가+체결+거래원 3콜 복원. 체결·거래원이 필요하면 WS(관심종목).
        self._capture_aux = capture_aux
        self._targets: set[str] = set()
        self._task: asyncio.Task[None] | None = None
        self._last_cycle_ms: int | None = None
        self._last_cycle_duration_ms: int | None = None
        self._last_error: str | None = None
        self._last_error_kind: str | None = None
        self._last_error_code: str | None = None
        self._last_error_count = 0
        self._closed_snapshotted_once: set[str] = set()
        self._trade_seen: dict[str, tuple[str, Counter[tuple[int, int, int, int]]]] = {}
        self._backoff_remaining = 0

    def _default_trading_day_fn(self) -> bool:
        from hoga.live.session_gate import is_trading_day_now  # noqa: PLC0415

        return is_trading_day_now(self._now_ms())

    def set_targets(self, codes: set[str]) -> None:
        self._targets = set(codes)
        self._closed_snapshotted_once &= self._targets
        for code in list(self._trade_seen):
            if code not in self._targets:
                del self._trade_seen[code]

    @property
    def alive(self) -> bool:
        return self._task is not None and not self._task.done()

    def status(self) -> Rest30sStatus:
        return Rest30sStatus(
            running=self.alive,
            target_count=len(self._targets),
            targets=tuple(sorted(self._targets)),
            last_cycle_ms=self._last_cycle_ms,
            last_error=self._last_error,
            last_error_kind=self._last_error_kind,
            last_error_code=self._last_error_code,
            last_error_count=self._last_error_count,
            backoff_remaining=self._backoff_remaining,
            degraded=self._last_error_count > 0,
            last_cycle_duration_ms=self._last_cycle_duration_ms,
        )

    def start(self) -> None:
        if self.alive:
            return
        self._task = asyncio.create_task(self._run_loop(), name="live-rest30-recorder")

    async def stop(self) -> None:
        if self._task is None or self._task.done():
            return
        self._task.cancel()
        try:
            await self._task
        except asyncio.CancelledError:
            pass

    async def _run_loop(self) -> None:
        while True:
            try:
                await self.poll_once()
            except Exception as e:
                self._record_cycle_error(e)
            await asyncio.sleep(self._next_delay_s())

    def _next_delay_s(self) -> float:
        """다음 벽시계 interval 경계까지의 지연(초). 사이클 시작을 경계에 정렬해
        위상 밀림('poll 후 sleep(interval)'이 사이클 소요만큼 매번 뒤로 밀리는 것)을
        없앤다. 사이클이 interval을 넘겨도 다음 경계에서 즉시 재개(밀리지 않음).
        stream.py의 _next_window_delay_s 미러."""
        now_s = self._now_ms() / 1000.0
        return self._interval_s - (now_s % self._interval_s)

    def _mark_cycle_complete(self, cycle_start_ms: int) -> None:
        """사이클 종료 시각과 소요를 함께 기록한다. poll_once의 모든 종료 경로
        (backoff·no-targets·no-kis 조기 return 포함)에서 호출해야 last_cycle_duration_ms
        가 stale 되지 않는다 — backoff/idle 사이클은 소요 ≈ 0으로 정직하게 남고,
        직전의 느린 fetch 값이 관측 지표에 계속 비치는 것을 막는다(ADR-0098 검증용)."""
        self._last_cycle_ms = self._now_ms()
        self._last_cycle_duration_ms = self._last_cycle_ms - cycle_start_ms

    def _record_cycle_error(self, exc: Exception) -> None:
        policy = classify_live_error(exc, internal=True)
        self._last_error = format_live_error(exc)
        self._last_error_kind = policy.kind
        self._last_error_code = policy.code
        self._last_error_count = 1
        self._backoff_remaining = max(self._backoff_remaining, policy.backoff_cycles)
        log_msg = "live.rest30.cycle_failed kind=%s error=%s"
        if policy.include_traceback:
            _log.error(log_msg, policy.kind, policy.code, exc_info=True)
        else:
            _log.warning(log_msg, policy.kind, policy.code)

    async def poll_once(self) -> None:
        cycle_start_ms = self._now_ms()
        if self._backoff_remaining > 0:
            self._backoff_remaining -= 1
            self._mark_cycle_complete(cycle_start_ms)
            return

        # 거래일 게이트(ADR-0099 저장 파리티) — 비거래일(주말/휴장)엔 저장 절대 금지.
        # market_phase(시계만)는 토요일 09:00–15:30에도 "regular"라 closed 게이트를
        # 통과시켜 유령 캡처를 만들었다. WS 저장(ws_capture_window)과 동일하게 캘린더로
        # 차단한다. blocking 계약이라 to_thread로 봉인(사이클 격리가 예외 흡수).
        is_trading = await asyncio.to_thread(self._trading_day_fn)
        if not is_trading:
            self._closed_snapshotted_once.clear()
            self._mark_cycle_complete(cycle_start_ms)
            self._last_error_count = 0
            self._last_error = None
            self._last_error_kind = None
            self._last_error_code = None
            return

        phase = self._phase_fn()
        targets = set(self._targets)
        closed = phase == "closed"
        if closed:
            targets -= self._closed_snapshotted_once
        else:
            self._closed_snapshotted_once.clear()

        if not targets:
            self._mark_cycle_complete(cycle_start_ms)
            self._last_error_count = 0
            self._last_error = None
            self._last_error_kind = None
            self._last_error_code = None
            return

        kis = self._resolve_kis()
        if kis is None:
            self._mark_cycle_complete(cycle_start_ms)
            self._last_error = "kis_unavailable"
            self._last_error_kind = "auth"
            self._last_error_code = "kis_unavailable"
            self._last_error_count = 1 if self._targets else 0
            return

        # 코드 간 동시 디스패치(코드 내부는 순차). 한 종목 실패는 _run_one 내부에서
        # 잡아 gather를 취소하지 않는다(격리 불변식 보존). gather는 입력 순서대로
        # 결과를 돌려주므로 sorted(targets) 순으로 결정론적 집계.
        sem = asyncio.Semaphore(self._concurrency)

        async def _run_one(code: str) -> tuple[str, Exception | None]:
            async with sem:
                try:
                    await self._fetch_write_publish(code, kis, phase=phase)
                    return code, None
                except Exception as e:  # noqa: BLE001
                    return code, e

        results = await asyncio.gather(*(_run_one(code) for code in sorted(targets)))

        error_count = 0
        last_error: str | None = None
        last_error_kind: str | None = None
        last_error_code: str | None = None
        for code, err in results:
            if err is None:
                if closed:
                    self._closed_snapshotted_once.add(code)
                continue
            policy = classify_live_error(err)
            error_count += 1
            last_error = format_live_error(err)
            last_error_kind = policy.kind
            last_error_code = policy.code
            if policy.backoff_cycles > 0:
                self._backoff_remaining = max(
                    self._backoff_remaining,
                    max(self._backoff_cycles, policy.backoff_cycles),
                )
            if policy.include_traceback:
                _log.error(
                    "live.rest30.code_failed code=%s kind=%s error=%s",
                    code,
                    policy.kind,
                    policy.code,
                    exc_info=err,
                )
            else:
                _log.warning(
                    "live.rest30.api_code_failed code=%s kind=%s error=%s",
                    code,
                    policy.kind,
                    policy.code,
                )

        await self._writer.fsync_all()
        self._mark_cycle_complete(cycle_start_ms)
        self._last_error = last_error
        self._last_error_kind = last_error_kind
        self._last_error_code = last_error_code
        self._last_error_count = error_count

    async def _fetch_write_publish(
        self,
        code: str,
        kis: KisRestCaptureProto,
        *,
        phase: str,
    ) -> None:
        now_ms = self._now_ms()
        date = self._date_fn()

        ob = await kis.fetch_orderbook(code)
        monitor = get_signal_alert_monitor()
        if monitor is not None:
            monitor.ingest_orderbook(
                code=code,
                name=code,
                t_ms=ob.t_ms,
                total_ask_qty=ob.total_ask_qty,
                source="rest",
            )
        # 기본은 10호가만(ADR-0098). capture_aux=True일 때만 체결·거래원 3콜 복원.
        snapshots = [ob_to_snapshot(ob, phase=phase)]
        if self._capture_aux:
            trades = await kis.fetch_trades(code)
            brokers = await kis.fetch_brokers(code)
            trades = self._dedupe_trades(code, date, trades)
            snapshots += [
                *trades_to_snapshots(trades, phase=phase),
                brokers_to_snapshot(brokers, now_ms=now_ms, phase=phase),
            ]
        await self._writer.append(date, code, snapshots)
        await self._buffer.publish(code, snapshots, now_ms=now_ms)

    def _dedupe_trades(
        self,
        code: str,
        date: str,
        trades: list[KisTrade],
    ) -> list[KisTrade]:
        seen_date, seen = self._trade_seen.get(code, (date, Counter()))
        if seen_date != date:
            seen = Counter()
        emitted_this_batch: Counter[tuple[int, int, int, int]] = Counter()
        fresh: list[KisTrade] = []
        for trade in trades:
            key = (trade.t_ms, trade.price, trade.qty, trade.side)
            emitted_this_batch[key] += 1
            if emitted_this_batch[key] <= seen[key]:
                continue
            fresh.append(trade)
        for key, count in emitted_this_batch.items():
            seen[key] = max(seen[key], count)
        self._trade_seen[code] = (date, seen)
        return fresh
