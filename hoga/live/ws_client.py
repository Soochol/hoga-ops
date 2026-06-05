"""KIS WebSocket 클라이언트 — 연결·구독·PINGPONG·백오프 재연결 (spec §7).

순수 파싱은 ws_frames에 위임. 이 모듈은 소켓 수명만 책임진다.
재연결: (1,2,4,8,16,32,60)s 백오프 + 성공 시 전 종목 재구독.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from collections.abc import Awaitable, Callable

import websockets

from . import ws_fields as F
from .ws_frames import WsTick, parse_message

_log = logging.getLogger(__name__)

WS_URL_REAL = "ws://ops.koreainvestment.com:21000"
_TRS = (F.TR_ORDERBOOK, F.TR_TRADE, F.TR_MEMBER)
_BACKOFF_S = (1, 2, 4, 8, 16, 32, 60)


def build_request(approval_key: str, tr_type: str, tr_id: str, tr_key: str) -> str:
    return json.dumps({
        "header": {"approval_key": approval_key, "custtype": "P",
                   "tr_type": tr_type, "content-type": "utf-8"},
        "body": {"input": {"tr_id": tr_id, "tr_key": tr_key}},
    })


class KisWsClient:
    def __init__(
        self,
        *,
        approval_key_fn: Callable[[], Awaitable[str]] | None,
        on_tick: Callable[[WsTick], Awaitable[None]] | None,
        date_fn: Callable[[], str],
        url: str = WS_URL_REAL,
        gate_fn: Callable[[], bool] | None = None,
    ) -> None:
        self._approval_key_fn = approval_key_fn
        self._on_tick = on_tick
        self._date_fn = date_fn
        self._url = url
        self._gate_fn = gate_fn   # advisor B: 게이트 밖에선 (재)연결 시도 안 함
        self._codes: list[str] = []
        self._ws: object | None = None
        self.last_tick_ms: int | None = None   # stream watchdog이 읽음
        self.connected: bool = False

    async def run(self, codes: list[str]) -> None:
        """끊겨도 살아남는 메인 루프 — 호출자(stream)가 task로 돌리고 cancel로 끝낸다."""
        self._codes = list(codes)
        attempt = 0
        while True:
            if self._gate_fn is not None and not self._gate_fn():
                self.connected = False
                await asyncio.sleep(30)   # 장외/15:30 이후 — 연결 시도 보류
                continue
            try:
                approval = await self._approval_key_fn()
                async with websockets.connect(self._url, ping_interval=None) as ws:
                    self._ws = ws
                    self.connected = True
                    attempt = 0
                    await self._send_subscriptions(ws, approval, self._codes, tr_type="1")
                    _log.info("live.ws.connected codes=%d regs=%d",
                              len(self._codes), len(self._codes) * len(_TRS))
                    await self._recv_loop(ws)
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001 — 연결 오류는 전부 재시도 대상
                self.connected = False
                self._ws = None
                delay = _BACKOFF_S[min(attempt, len(_BACKOFF_S) - 1)]
                attempt += 1
                _log.warning("live.ws.reconnect attempt=%d delay=%ds err=%r",
                             attempt, delay, e)
                await asyncio.sleep(delay)

    async def update_codes(self, codes: list[str]) -> None:
        """Live Set 변경(watchlist reorder) — diff만 구독/해제."""
        new, old = set(codes), set(self._codes)
        self._codes = list(codes)
        ws = self._ws
        if ws is None:
            return  # 다음 (재)연결 때 전체 구독
        approval = await self._approval_key_fn()
        added = [c for c in codes if c not in old]
        removed = [c for c in old if c not in new]
        if removed:
            await self._send_subscriptions(ws, approval, removed, tr_type="2")
        if added:
            await self._send_subscriptions(ws, approval, added, tr_type="1")

    async def _send_subscriptions(
        self, ws, approval_key: str, codes: list[str], *, tr_type: str
    ) -> None:
        for code in codes:
            for tr in _TRS:
                await ws.send(build_request(approval_key, tr_type, tr, code))

    async def _recv_loop(self, ws) -> None:
        date = self._date_fn()
        while True:
            raw = await ws.recv()
            if raw and raw[0] in ("0", "1"):
                now_ms = int(time.time() * 1000)
                for tick in parse_message(raw, date=date, now_ms=now_ms):
                    self.last_tick_ms = now_ms
                    if self._on_tick is not None:
                        await self._on_tick(tick)
            else:
                try:
                    msg = json.loads(raw)
                except (TypeError, json.JSONDecodeError):
                    continue
                tr_id = msg.get("header", {}).get("tr_id")
                if tr_id == "PINGPONG":
                    await ws.send(raw)  # 공식 규약: 받은 메시지 그대로 echo
                else:
                    _log.info("live.ws.control tr_id=%s msg=%s",
                              tr_id, str(msg.get("body", {}))[:200])
