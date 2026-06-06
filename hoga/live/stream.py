"""LiveStream — WS 수집 오케스트레이터 (spec §6·§7).

per-tick: LiveBuffer.publish (표시, sub-second / ADR-0053 다운스트림 무변경)
10초:    TickDownsampler.flush → LiveWriter.append (저장; ADR-0038 hot-path
         invariant — JSONL만 쓴다)
게이팅:  session_gate.ws_capture_window(09:00–15:30, advisor B) — 밖에선
         flush 안 함 + WS (재)연결 보류. 장후 시간외는 의도적 회귀(spec §11).
"""
from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Callable

from .buffer import LiveBuffer
from .downsampler import TickDownsampler
from .session_gate import market_phase, ws_capture_window
from .snapshot import LiveSnapshot
from .writer import LiveWriter
from .ws_client import KisWsClient
from .ws_frames import WsTick

_log = logging.getLogger(__name__)

FLUSH_INTERVAL_S = 10.0
IDLE_INTERVAL_S = 1.0  # 게이트 밖 폴링 주기 — 테스트에서 monkeypatch(리뷰 R3)


def _now_ms() -> int:
    return int(time.time() * 1000)


class LiveStream:
    def __init__(
        self,
        *,
        buffer: LiveBuffer,
        writer: LiveWriter,
        date_fn: Callable[[], str],
        phase_fn: Callable[[], str] | None = None,
    ) -> None:
        self._buffer = buffer
        self._writer = writer
        self._date_fn = date_fn
        self._phase_fn = phase_fn or (lambda: market_phase(_now_ms()))
        self._ds = TickDownsampler()
        self.ws: KisWsClient | None = None       # lifecycle이 주입
        self.last_flush_ms: int | None = None
        self._last_flush_date: str | None = None  # R1: 미관측 일경계 백스톱
        # R2: 게이트 판정은 flush 루프가 1Hz로 유지 — on_tick은 이 플래그만 읽는다
        # (per-tick 달력 평가는 fetch 실패 모드에서 틱당 동기 네트워크 콜이 됨).
        self._gate_open: bool = False

    def set_active_codes(self, codes: set[str]) -> None:
        """Live Set 변경 위임 — refresh_live_stream이 호출(advisor C)."""
        self._ds.set_active_codes(codes)

    async def on_tick(self, tick: WsTick) -> None:
        """ws_client 콜백 — 표시 경로(즉시·무게이트) + 저장 경로(누적·게이트)."""
        # phase 이중 스탬프(M1): 여기 phase는 **표시 스냅샷 전용** — 수신 벽시계
        # 기준 위상을 buffer 스냅에 박는다(tick.t_ms 거래소 시각이 아니라 도착
        # 시점). 저장 경로의 위상은 별개로 flush 시점에 _ds.flush(phase=...)가
        # 박는다(M2 참고) — ingest는 raw tick만 받으므로 이 phase를 안 본다.
        phase = self._phase_fn()
        snap = LiveSnapshot(t_ms=tick.t_ms, kind=tick.kind,
                            payload={**tick.payload, "phase": phase})
        # 표시 경로는 §11에 따라 무게이트 — 항상 publish.
        await self._buffer.publish(tick.code, [snap], now_ms=_now_ms())
        # 저장 경로만 게이트 — 15:30 이후 잔여 틱이 다운샘플러에 누적돼 밤을
        # 넘기는 것을 차단(리뷰 C1 벡터 1). 판정은 flush 루프가 유지하는
        # 플래그(리뷰 R2 — per-tick 달력 평가 금지); 닫힘 직후 ≤10s의 잔여
        # ingest는 전환 drain이 마감 당일로 귀속한다.
        if self._gate_open:
            self._ds.ingest(tick)

    async def flush_once(self, *, now_ms: int | None = None) -> None:
        now_ms = now_ms if now_ms is not None else _now_ms()
        # date/phase는 flush 호출 시점의 샘플 — 윈도 내 틱들이 아니라 마감 순간의
        # 날짜·위상으로 귀속된다(M2). 게이트 닫힘 전환 drain은 15:30:0x 수 초 내라
        # date_fn이 아직 당일이어서 마지막 부분 윈도가 올바른 날짜로 기록된다.
        date = self._date_fn()
        if self._last_flush_date is not None and date != self._last_flush_date:
            # 미관측 일경계(suspend/시계 점프 — 리뷰 R1): 어제 잔여 상태가
            # 오늘 날짜로 기록되는 것을 차단. KRX 세션은 자정을 넘지 않으므로
            # 날짜 변화 시 reset은 항상 안전하다(정상 경로에선 drain이 이미 비움).
            self._ds.reset()
            _log.warning("live.stream.stale_state_reset prev=%s now=%s",
                         self._last_flush_date, date)
        self._last_flush_date = date
        flushed = self._ds.flush(now_ms=now_ms, phase=self._phase_fn())
        for code, snaps in flushed.items():
            await self._writer.append(date, code, snaps)
        await self._writer.fsync_all()
        self.last_flush_ms = now_ms

    async def run_flush_loop(self) -> None:
        """10초 flush 루프 — lifecycle이 task로 돌린다. 게이트 밖(장외·15:30 이후)엔
        1초 idle — advisor B: 15:30 이후 쓰기를 막아 유령 carry를 차단한다.

        게이트가 닫히는 전환 순간 drain flush 1회(마지막 부분 윈도를 **마감 당일**
        날짜로 기록) 후 다운샘플러를 reset — 흐름 합·carry가 밤을 넘겨 다음
        거래일 JSONL을 오염시키지 않게 한다(리뷰 C1)."""
        was_open = False
        while True:
            open_now = ws_capture_window(_now_ms())
            self._gate_open = open_now  # R2: on_tick의 ingest 게이트 플래그 갱신
            if open_now:
                started = time.monotonic()
                try:
                    await self.flush_once()
                except Exception:  # noqa: BLE001
                    _log.exception("live.stream.flush_failed")
                elapsed = time.monotonic() - started
                await asyncio.sleep(max(0.0, FLUSH_INTERVAL_S - elapsed))
            else:
                if was_open:  # open→closed 전환: drain + 상태 초기화
                    try:
                        await self.flush_once()
                    except Exception:  # noqa: BLE001
                        _log.exception("live.stream.drain_flush_failed")
                    self._ds.reset()
                    _log.info("live.stream.gate_closed_drained")
                await asyncio.sleep(IDLE_INTERVAL_S)
            was_open = open_now
