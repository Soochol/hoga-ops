"""프로그램매매 사이드카 flush 루프 — 키움 0w latch → ProgramTradeStore (PR-F4).

원래는 KIS REST(FHPPG04650101)를 30초 폴링하던 수집기였으나, 0w push 전환으로
"fetch" 가 사라지고 **drain** 만 남았다: stream.on_tick 이 program_trade_latch 에
남긴 종목별 최신 0w 스냅샷을 30초 주기로 store.merge_response 에 병합한다.
루프·게이트(ws_capture_window)·store·이상탐지·상태 관측은 REST 시절 그대로 —
저장 해상도(30초)와 디스크 IO 패턴이 불변이라 소비(/api/range)·프론트도 무변경.

targets 관측은 latch 에 실제로 남은 코드 집합으로 대체됐다(구독 SSOT 는 키움
세션이 소유하므로 여기서 관심종목을 재계산하지 않는다).
"""
from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from hoga.api.timeenc import KST

from . import program_trade_latch
from .error_policy import classify_live_error, format_live_error
from .program_trade_store import ProgramTradeByStockRow, ProgramTradeStore
from .session_gate import ws_capture_window

log = logging.getLogger(__name__)

@dataclass(slots=True)
class ProgramTradeCollectorStatus:
    running: bool = False
    targets: tuple[str, ...] = ()
    last_cycle_ms: int | None = None
    last_error: str | None = None
    last_error_kind: str | None = None
    last_error_code: str | None = None
    last_error_count: int = 0


class ProgramTradeCollector:
    def __init__(
        self,
        *,
        data_dir: Path,
        date_fn: Callable[[], str],
        now_ms_fn: Callable[[], int],
        should_collect_fn: Callable[[int], bool] = ws_capture_window,
        poll_interval_s: float = 30.0,
    ) -> None:
        self.data_dir = data_dir
        self.store = ProgramTradeStore(data_dir, poll_interval_ms=int(poll_interval_s * 1000))
        self._date_fn = date_fn
        self._now_ms_fn = now_ms_fn
        self._should_collect_fn = should_collect_fn
        self._poll_interval_s = poll_interval_s
        self.status = ProgramTradeCollectorStatus()
        self._task: asyncio.Task | None = None
        # delta 파생용 — code → (net_qty, net_amount) 직전 flush 값. 211/213(이벤트
        # 증감)은 재전송·유실에 취약해 미소비하고(F3 권고), flush 간 누적 diff 로
        # REST 30초의 icdc 의미(주기 증감)를 재현한다. 날짜가 바뀌면 리셋.
        self._last_net: dict[str, tuple[int | None, int | None]] = {}
        self._last_date: str | None = None

    def start(self) -> None:
        if self._task is not None and not self._task.done():
            return
        self._task = asyncio.create_task(self._loop(), name="program-trade-collector")
        self.status.running = True

    async def stop(self) -> None:
        task = self._task
        self.status.running = False
        if task is not None and not task.done():
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
        self._task = None

    async def _loop(self) -> None:
        while True:
            try:
                await self.run_once()
            except Exception as e:
                self._record_cycle_error(e)
            await asyncio.sleep(self._poll_interval_s)

    def _record_cycle_error(self, exc: Exception) -> None:
        policy = classify_live_error(exc, internal=True)
        self.status.last_error = format_live_error(exc)
        self.status.last_error_kind = policy.kind
        self.status.last_error_code = policy.code
        self.status.last_error_count = 1
        log_msg = "program_trade.collector.cycle_failed kind=%s error=%s"
        if policy.include_traceback:
            log.error(log_msg, policy.kind, policy.code, exc_info=True)
        else:
            log.warning(log_msg, policy.kind, policy.code)

    async def run_once(self) -> None:
        self.status.last_error = None
        self.status.last_error_kind = None
        self.status.last_error_code = None
        self.status.last_error_count = 0
        date = self._date_fn()
        observed_at_ms = self._now_ms_fn()
        if date != self._last_date:
            # 새 거래일 — 전일 누적 대비 delta 를 만들면 첫 행이 음수 폭주한다.
            self._last_net = {}
            self._last_date = date
        if not self._should_collect_fn(observed_at_ms):
            self.status.last_cycle_ms = observed_at_ms
            return

        latched = program_trade_latch.drain()
        self.status.targets = tuple(sorted(latched))
        for code, payload in latched.items():
            try:
                row = self._to_row(code, payload)
                self.store.merge_response(
                    code=code,
                    date=date,
                    rows=[row],
                    observed_at_ms=observed_at_ms,
                )
            except Exception as e:  # noqa: BLE001 — per-code failures must stay local.
                policy = classify_live_error(e)
                self.status.last_error = f"{code}: {format_live_error(e)}"
                self.status.last_error_kind = policy.kind
                self.status.last_error_code = policy.code
                self.status.last_error_count += 1
                log_msg = "program_trade.collector.code_failed code=%s kind=%s error=%s"
                if policy.include_traceback:
                    log.error(log_msg, code, policy.kind, policy.code, exc_info=True)
                else:
                    log.warning(log_msg, code, policy.kind, policy.code)

        self.status.last_cycle_ms = observed_at_ms

    def _to_row(self, code: str, payload: dict) -> ProgramTradeByStockRow:
        """0w latch payload(kiwoom_frames._parse_program 산출) → store Row.

        bsop_hour(store 병합 키)는 틱 수신 t_ms 의 KST HHMMSS — REST 가 KIS 응답의
        집계시각을 쓰던 자리를 수신 시각이 대신한다(0w 에 시각 FID 없음).
        """
        t_ms = int(payload["t_ms"])
        bsop_hour = datetime.fromtimestamp(t_ms / 1000, KST).strftime("%H%M%S")
        net_qty = payload.get("net_qty")
        net_amount = payload.get("net_amount")
        prev_qty, prev_amount = self._last_net.get(code, (None, None))
        self._last_net[code] = (net_qty, net_amount)
        return ProgramTradeByStockRow(
            code=code,
            bsop_hour=bsop_hour,
            t_ms=t_ms,
            sell_qty=payload.get("sell_qty"),
            sell_amount=payload.get("sell_amount"),
            buy_qty=payload.get("buy_qty"),
            buy_amount=payload.get("buy_amount"),
            net_qty=net_qty,
            net_amount=net_amount,
            delta_qty=(
                net_qty - prev_qty
                if net_qty is not None and prev_qty is not None else None
            ),
            delta_amount=(
                net_amount - prev_amount
                if net_amount is not None and prev_amount is not None else None
            ),
            price=payload.get("price") or None,
        )
