"""키움 온디맨드 표시전용 WS — 낯선 종목(관심·히트맵 밖) 열람 시 임시 실시간 (ADR-0116).

사용자가 WS 커버리지 밖 종목을 열면 키움 WS에 임시 구독해 **표시 전용**(LiveBuffer만,
저장 없음)으로 실시간 틱을 흘리고, 닫으면 해제한다. KIS 2초 REST 폴러(rest_poller)의
키움 WS판 — 인터페이스(on_subscribe/on_unsubscribe/set_excluded_codes)를 미러해 뷰-구독
경로가 양쪽을 동형으로 구동한다.

**저장 금지**: 잠깐 본 종목이 디스크에 남으면 반쪽 캡처가 완결성 판정을 오염시킨다
(rest_buffer_build와 동일 원칙 — 표시 링에만 publish). 그래서 LiveStream(저장 경로)을
쓰지 않고 buffer.publish만 한다.

**전용 앱키 필수**: 키움은 앱키당 세션 1개(신규가 기존 킥, 실측 2026-07-16). 히트맵이
전 앱키를 쓰면 온디맨드용 세션이 없으므로, 온디맨드는 히트맵이 안 쓰는 **예약 앱키**의
KiwoomWsClient를 받아야 한다(주입). 예약 앱키가 없으면 세션 미구성 → no-op(KIS 2s 폴백).

kis_* 모듈은 import하지 않는다(ADR-0116 규율 1).
"""
from __future__ import annotations

import asyncio
import contextlib
import time
from collections.abc import Awaitable, Callable

from .buffer import LiveBuffer
from .kiwoom_ws_client import KiwoomWsClient
from .session_gate import market_phase
from .snapshot import LiveSnapshot
from .ws_frames import WsTick

# 예약 앱키 클라이언트를 on_tick 콜백을 받아 만드는 팩토리. 예약 앱키 부재면 None.
ClientFactory = Callable[[Callable[[WsTick], Awaitable[None]]], KiwoomWsClient | None]


class KiwoomOnDemandSession:
    """단일 키움 WS(예약 앱키)로 열람 종목을 임시 구독 — 표시 전용.

    targets = _subscribed − _excluded. 변경 시 client.update_codes로 반영. 팩토리가
    None(예약 앱키 부재)이면 전 조작 no-op(호출자 무변경 — KIS 2s 폴러가 대체)."""

    def __init__(
        self,
        *,
        buffer: LiveBuffer,
        client_factory: ClientFactory,
        date_fn: Callable[[], str],
        now_ms_fn: Callable[[], int] | None = None,
    ) -> None:
        self._buffer = buffer
        self._client_factory = client_factory
        self._client: KiwoomWsClient | None = None
        self._date_fn = date_fn
        self._now_ms = now_ms_fn or (lambda: int(time.time() * 1000))
        self._subscribed: set[str] = set()
        self._excluded: set[str] = set()
        self._task: asyncio.Task | None = None
        self._apply_lock = asyncio.Lock()

    async def _on_tick(self, tick: WsTick) -> None:
        """표시 전용 — LiveBuffer.publish만(저장·다운샘플·피크 없음). venue/phase는
        stream 표시 경로와 동일 키로 실어 프론트 무변경."""
        now = self._now_ms()
        snap = LiveSnapshot(
            t_ms=tick.t_ms, kind=tick.kind,
            payload={**tick.payload, "phase": market_phase(now), "venue": tick.venue},
        )
        await self._buffer.publish(tick.code, [snap], now_ms=now)

    @property
    def _targets(self) -> set[str]:
        return self._subscribed - self._excluded

    def on_subscribe(self, code: str) -> None:
        """열람 대상 추가(뷰 열림)."""
        self._subscribed.add(code)
        self._schedule_apply()

    def on_unsubscribe(self, code: str) -> None:
        """열람 대상 제거(뷰 닫힘) — 키움 WS 슬롯 반납."""
        self._subscribed.discard(code)
        self._schedule_apply()

    def set_excluded_codes(self, codes: set[str]) -> None:
        """WS 커버리지(관심 live_set ∪ 히트맵 키움) 종목 — 온디맨드에서 배타(이미 실시간)."""
        self._excluded = set(codes)
        self._schedule_apply()

    @property
    def alive(self) -> bool:
        return self._task is not None and not self._task.done()

    def start(self) -> None:
        """예약 앱키 클라이언트를 표시전용 on_tick으로 만들어 run 루프 시작. 예약 앱키
        없으면(팩토리 None) no-op — 온디맨드 비활성(KIS 2s 폴러가 대체)."""
        if self.alive:
            return
        self._client = self._client_factory(self._on_tick)
        if self._client is None:
            return
        self._task = asyncio.create_task(
            self._client.run(sorted(self._targets)), name="kiwoom-ondemand-ws",
        )

    async def stop(self) -> None:
        if self._task is None or self._task.done():
            return
        self._task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await self._task

    def _schedule_apply(self) -> None:
        """targets 변경을 client에 반영. 미연결/미배선이면 무시(다음 연결이 반영)."""
        if self._client is None:
            return
        asyncio.ensure_future(self._apply())

    async def _apply(self) -> None:
        if self._client is None:
            return
        async with self._apply_lock:
            await self._client.update_codes(sorted(self._targets))

    def status(self) -> dict:
        return {
            "enabled": self._client is not None,
            "running": self.alive,
            "target_count": len(self._targets),
            "targets": sorted(self._targets),
        }
