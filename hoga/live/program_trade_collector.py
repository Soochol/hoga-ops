"""프로그램매매 사이드카 flush 루프 — 키움 0w latch → ProgramTradeStore (PR-F4).

원래는 KIS REST(FHPPG04650101)를 30초 폴링하던 수집기였으나, 0w push 전환으로
"fetch" 가 사라지고 **drain** 만 남았다: stream.on_tick 이 program_trade_latch 에
남긴 종목별 최신 0w 스냅샷을 30초 주기로 store.merge_response 에 병합한다.
루프·store·이상탐지·상태 관측은 REST 시절 그대로 — 저장 해상도(30초)와 디스크 IO
패턴이 불변이다.

**게이트는 venue 별로 갈렸다**(ADR-0140 §3). 예전엔 `ws_capture_window`(KRX
09:00–15:30) 하나로 닫고 KRX 태그만 병합했다 — 사이드카 저장소에 venue 축이
없어서였다. 그 결과 애프터마켓 프로그램 순매수가 **어디에도 남지 않았고**, 화면은
표시 링(15분)이 닿는 동안만 값을 보였다(2026-08-07 실측: 사이드카 15:29:37 종료 대
WS 링 최근 15분 = 약 3시간 공백). 이제 `venue_capture_windows` 가 여는 창
(KRX 09:00–15:30 · NXT·UN 08:00–20:00)만큼 venue 별 파일로 남는다.

targets 관측은 latch 에 실제로 남은 코드 집합으로 대체됐다(구독 SSOT 는 키움
세션이 소유하므로 여기서 관심종목을 재계산하지 않는다).
"""
from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from hoga.util.timeenc import KST

from . import program_trade_latch
from .error_policy import classify_live_error, format_live_error
from .program_trade_store import ProgramTradeByStockRow, ProgramTradeStore
from .session_gate import venue_capture_windows_async

log = logging.getLogger(__name__)

@dataclass(slots=True)
class ProgramTradeCollectorStatus:
    # NOTE: 이 플래그는 start()/stop() 에서만 갱신되므로 **태스크가 죽어도 True** 로
    # 남는다(ADR-0064 가 제거한 거짓 health 패턴). 정직한 판정은
    # ProgramTradeCollector.task 를 보는 lifecycle.get_program_trade_task() 경유
    # supervised_tasks 이며, 이 필드는 "기동 의도" 만 뜻한다.
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
        # **async 다** — 캘린더 캐시 미스 시 동기 HTTP 를 칠 수 있어 이벤트 루프에서
        # 직접 부르면 안 된다(session_gate 의 blocking 계약). 예전 sync
        # `should_collect_fn` 은 그 계약을 어기고 있었다.
        open_venues_fn: Callable[[int], Awaitable[frozenset[str]]] = venue_capture_windows_async,
        poll_interval_s: float = 30.0,
    ) -> None:
        self.data_dir = data_dir
        self.store = ProgramTradeStore(data_dir, poll_interval_ms=int(poll_interval_s * 1000))
        self._date_fn = date_fn
        self._now_ms_fn = now_ms_fn
        self._open_venues_fn = open_venues_fn
        self._poll_interval_s = poll_interval_s
        self.status = ProgramTradeCollectorStatus()
        self._task: asyncio.Task | None = None
        # delta 파생용 — (code, venue) → (net_qty, net_amount) 직전 flush 값. 211/213
        # (이벤트 증감)은 재전송·유실에 취약해 미소비하고(F3 권고), flush 간 누적 diff 로
        # REST 30초의 icdc 의미(주기 증감)를 재현한다. 날짜가 바뀌면 리셋.
        #
        # ⚠ 키에 venue 가 **반드시** 들어간다. code 만으로 키잉하면 세 시장의 누적이
        # 한 칸을 공유해 delta 가 "직전 도착 시장과의 차이" 가 된다 — 값이 틀리는 게
        # 아니라 **다른 시장 사이의 뺄셈**이라 부호까지 뒤집힌다(latch 가 code 키였을
        # 때 프로그램 순매수가 겪은 것과 같은 형태의 섞임, ADR-0140 §2).
        self._last_net: dict[tuple[str, str], tuple[int | None, int | None]] = {}
        self._last_date: str | None = None

    @property
    def task(self) -> asyncio.Task | None:
        """실행 태스크 핸들 — ADR-0088 정직한 liveness 판정의 유일한 근거.

        `status.running` 은 기동 의도만 뜻하고 태스크 사망을 반영하지 않는다.
        """
        return self._task

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
            try:  # noqa: SIM105 — teardown/idempotent close — 예외 무시가 의도
                await task
            except asyncio.CancelledError:
                pass
        self._task = None

    async def _loop(self) -> None:
        while True:
            try:
                await self.run_once()
            except Exception as e:  # noqa: BLE001 — 수집 루프의 감독자. 한 사이클의 어떤
                # 예외도 루프를 죽이면 안 된다(죽으면 수집이 조용히 멈춘다). 삼키는 게
                # 아니라 _record_cycle_error 가 분류해 상태로 노출한다.
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
        open_venues = await self._open_venues_fn(observed_at_ms)
        if not open_venues:
            self.status.last_cycle_ms = observed_at_ms
            return

        # latch 는 (code, venue) 로 키잉돼 있고 저장소도 이제 그 축을 가진다 — 창이
        # 열린 venue 를 **각자의 파일로** 병합한다.
        #
        # drain 은 창 밖 venue 프레임도 함께 비운다(전량 drain). 그 자리는 저장하지
        # 않는 것이 맞고(창 = 저장 여부의 정의), 남겨 두면 창이 열리는 순간 몇 시간
        # 묵은 값이 그 시각의 관측인 척 들어간다.
        latched = {
            (code, venue): payload
            for (code, venue), payload in program_trade_latch.drain().items()
            if venue in open_venues
        }
        self.status.targets = tuple(sorted({code for (code, _venue) in latched}))
        for (code, venue), payload in latched.items():
            try:
                row = self._to_row(code, venue, payload)
                self.store.merge_response(
                    code=code,
                    date=date,
                    venue=venue,
                    rows=[row],
                    observed_at_ms=observed_at_ms,
                )
            except Exception as e:  # per-code failures must stay local.
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

    def _to_row(self, code: str, venue: str, payload: dict) -> ProgramTradeByStockRow:
        """0w latch payload(kiwoom_frames._parse_program 산출) → store Row.

        bsop_hour(store 병합 키)는 틱 수신 t_ms 의 KST HHMMSS — REST 가 KIS 응답의
        집계시각을 쓰던 자리를 수신 시각이 대신한다(0w 에 시각 FID 없음).

        `venue` 는 delta 상태 키에만 쓰인다(행 자체는 파일이 venue 를 들고 있다) —
        근거는 `_last_net` 주석.
        """
        t_ms = int(payload["t_ms"])
        bsop_hour = datetime.fromtimestamp(t_ms / 1000, KST).strftime("%H%M%S")
        net_qty = payload.get("net_qty")
        net_amount = payload.get("net_amount")
        prev_qty, prev_amount = self._last_net.get((code, venue), (None, None))
        self._last_net[(code, venue)] = (net_qty, net_amount)
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
