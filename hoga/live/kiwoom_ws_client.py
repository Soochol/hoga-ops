"""키움 WebSocket 클라이언트 — LOGIN·배치 REG·PING·킥 복구 (KisWsClient 브로커-대칭).

순수 파싱은 kiwoom_frames에 위임. 이 모듈은 소켓 수명·구독 상태만 책임진다.
관측성 표면(connected/last_tick_ms/expected/acked)은 KisWsClient와 통일하되(ADR-0116
규율 3), 골격은 다르다: KIS는 개별 (tr,code) 구독+중복거부, 키움은 배치 REG(item 리스트)+
킥(신규 세션이 기존 축출). kis_* 는 import하지 않는다(규율 1).

실측 근거(2026-07-16, 실계좌):
- 연결당 총 200종목(타입 무관). rc=105115/105118 = 슬롯 상한.
- REG 유량 ~5/s. rc=105110 = 유량 초과 → 백오프 재시도.
- 동일 앱키 2세션 → 기존이 close(1000,'Bye')로 킥.
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import time
from collections.abc import Awaitable, Callable
from typing import Protocol

import websockets

from .kiwoom_frames import parse_real_message

_log = logging.getLogger(__name__)


class _WsLike(Protocol):
    """websockets 연결의 최소 인터페이스 — fake 소켓 주입(테스트)도 만족한다.

    파라미터는 positional-only(/): websockets ClientConnection.send(message=...)와
    이름이 달라도 구조적으로 매칭되게 한다.
    """

    async def send(self, data: str | bytes, /) -> None: ...
    async def recv(self, /) -> str | bytes: ...
    async def close(self) -> None: ...

WS_URL_REAL = "wss://api.kiwoom.com:10000/api/dostk/websocket"
DEFAULT_TYPES = ("0B", "0D")  # 체결 + 호가 (히트맵 요건)
_REG_BATCH = 50  # item/REG (실측: 배치로 유량 5/s 회피)
_REG_PACING_S = 0.35  # ~3 REG/s 페이싱 (5/s 상한 여유)
_BACKOFF_S = (1, 2, 4, 8, 16, 32, 60)
_ACK_TIMEOUT_S = 10.0

# REG 응답 return_code (실측)
_RC_OK = 0
_RC_RATE_LIMIT = 105110  # 해당 TRNM 허용 요청 건수 초과 → 백오프 재시도
_RC_SLOT_CAP = frozenset({105115, 105118})  # 등록 허용 개수(200) 초과 → 상한
_MAX_RATE_RETRY = 6


class KiwoomSlotCapReached(RuntimeError):
    """연결당 등록 상한(200) 초과 — 더 등록 불가."""


class KiwoomWsClient:
    def __init__(
        self,
        *,
        token_fn: Callable[[], Awaitable[str]],
        on_tick: Callable[[object], Awaitable[None]] | None,
        date_fn: Callable[[], str],
        url: str = WS_URL_REAL,
        types: tuple[str, ...] = DEFAULT_TYPES,
        gate_fn: Callable[[], bool] | None = None,
        max_consecutive_kicks: int = 5,
        _connect: Callable[[str], Awaitable[_WsLike]] | None = None,
    ) -> None:
        self._token_fn = token_fn
        self._on_tick = on_tick
        self._date_fn = date_fn
        self._url = url
        self._types = list(types)
        self._gate_fn = gate_fn
        self._max_kicks = max_consecutive_kicks
        self._connect = _connect or self._default_connect
        self._codes: list[str] = []
        self._ws: _WsLike | None = None
        self._sub_lock = asyncio.Lock()  # 구독 전송 직렬화 — wire≠_codes 발산 방지
        self._acked: set[str] = set()  # REG ACK 받은 종목
        # 의미 분리(KisWsClient 미러): last_tick_ms=데이터 프레임 전용(표시),
        # last_recv_ms=모든 수신(PING 포함, watchdog liveness).
        self.last_tick_ms: int | None = None
        self.last_recv_ms: int | None = None
        self.connected: bool = False
        self.sub_rejected: int = 0
        self.kicked_by_peer: bool = False  # N회 연속 킥 → 다른 프로세스가 앱키 점유

    @staticmethod
    async def _default_connect(url: str) -> _WsLike:
        return await websockets.connect(url, ping_interval=None, max_size=None)

    @property
    def expected_codes(self) -> set[str]:
        """현재 구독 기대 종목 집합 — 파생값(저장 안 함)."""
        return set(self._codes)

    @property
    def sub_expected(self) -> int:
        return len(self._codes)

    @property
    def sub_acked(self) -> int:
        return len(self._acked & self.expected_codes)

    def sub_missing(self) -> list[str]:
        """기대하지만 REG ACK 미확인 종목 — 틱 유입 워치독/재구독 대상.

        실측: REG ACK는 코드 유효성을 검사하지 않아(쓰레기도 rc=0) ACK만으론 실효성을
        보장 못 한다. 상위 워치독이 이 목록 + 무틱 종목을 교차해 재구독한다(PR-4).
        """
        return sorted(self.expected_codes - self._acked)

    async def run(self, codes: list[str]) -> None:
        """끊겨도 살아남는 메인 루프 — 호출자가 task로 돌리고 cancel로 끝낸다.

        킥(close 1000)이 _max_kicks회 연속되면 kicked_by_peer로 정지(무한 핑퐁 방지).
        """
        self._codes = list(codes)
        attempt = 0
        consecutive_kicks = 0
        while True:
            if self._gate_fn is not None and not await asyncio.to_thread(self._gate_fn):
                self.connected = False
                await asyncio.sleep(30)
                continue
            was_kick = False
            try:
                await self._session_once()
                consecutive_kicks = 0
                attempt = 0
            except asyncio.CancelledError:
                self.connected = False
                raise
            except Exception as e:  # noqa: BLE001 — 연결 오류는 전부 재시도 대상
                self.connected = False
                self._ws = None
                was_kick = self._is_kick(e)
                if was_kick:
                    consecutive_kicks += 1
                    if consecutive_kicks >= self._max_kicks:
                        self.kicked_by_peer = True
                        _log.error(
                            "live.kiwoom.kicked_by_peer kicks=%d — 다른 프로세스가 "
                            "앱키 점유. 정지.", consecutive_kicks,
                        )
                        return
                    delay = _BACKOFF_S[min(attempt, len(_BACKOFF_S) - 1)]
                    attempt += 1
                    _log.warning("live.kiwoom.kicked attempt=%d delay=%ds", attempt, delay)
                else:
                    consecutive_kicks = 0
                    delay = _BACKOFF_S[min(attempt, len(_BACKOFF_S) - 1)]
                    attempt += 1
                    _log.warning("live.kiwoom.reconnect attempt=%d delay=%ds err=%r",
                                 attempt, delay, e)
                await asyncio.sleep(delay)

    async def _session_once(self) -> None:
        """1세션: connect → LOGIN → 전 종목 배치 REG → drain(수신). 끊기면 예외 전파."""
        token = await self._token_fn()
        ws = await self._connect(self._url)
        try:
            async with self._sub_lock:
                self._ws = ws
                self._acked.clear()
                self.sub_rejected = 0
                await self._login(ws, token)
                self.connected = True
                await self._register_all(ws, list(self._codes))
            _log.info("live.kiwoom.connected codes=%d acked=%d",
                      len(self._codes), len(self._acked))
            await self._drain(ws)
        finally:
            self.connected = False
            self._ws = None
            await self._safe_close(ws)

    async def _login(self, ws: _WsLike, token: str) -> None:
        await ws.send(json.dumps({"trnm": "LOGIN", "token": token}))
        ack = await self._read_until(ws, "LOGIN")
        rc = ack.get("return_code")
        if rc != _RC_OK:
            raise RuntimeError(f"kiwoom LOGIN failed rc={rc} {ack.get('return_msg')!r}")

    async def _register_all(self, ws: _WsLike, codes: list[str]) -> None:
        """전 종목을 배치(50)로 REG. rc 유량이면 백오프 재시도, 슬롯 상한이면 중단."""
        for start in range(0, len(codes), _REG_BATCH):
            chunk = codes[start : start + _REG_BATCH]
            try:
                await self._reg_batch(ws, chunk, tr="REG")
            except KiwoomSlotCapReached:
                _log.warning("live.kiwoom.slot_cap acked=%d requested=%d",
                             len(self._acked), len(codes))
                break
            self._acked.update(chunk)
            await asyncio.sleep(_REG_PACING_S)

    async def _reg_batch(self, ws: _WsLike, chunk: list[str], *, tr: str) -> None:
        """1배치 REG/REMOVE 송신 + ACK 대기. 유량 rc는 내부에서 백오프 재시도."""
        msg = json.dumps({
            "trnm": tr, "grp_no": "1", "refresh": "1",
            "data": [{"item": chunk, "type": self._types}],
        })
        for attempt in range(_MAX_RATE_RETRY):
            await ws.send(msg)
            ack = await self._read_until(ws, tr)
            rc = ack.get("return_code")
            if rc == _RC_OK:
                return
            if rc == _RC_RATE_LIMIT:
                await asyncio.sleep(1.0 + attempt)
                continue
            if rc in _RC_SLOT_CAP:
                raise KiwoomSlotCapReached(str(ack.get("return_msg")))
            self.sub_rejected += 1
            _log.warning("live.kiwoom.reg_rejected rc=%s msg=%s", rc, ack.get("return_msg"))
            return
        _log.warning("live.kiwoom.reg_rate_limited_persist chunk=%d", len(chunk))

    async def update_codes(self, codes: list[str]) -> None:
        """Live Set 변경 — diff만 REG(added)/REMOVE(removed). 미연결이면 상태만 갱신."""
        async with self._sub_lock:
            new, old = set(codes), set(self._codes)
            added = [c for c in codes if c not in old]
            removed = [c for c in old if c not in new]
            self._codes = list(codes)
            ws = self._ws
            if ws is None or (not added and not removed):
                self._acked -= set(removed)
                return
            if removed:
                with contextlib.suppress(KiwoomSlotCapReached):
                    await self._reg_batch(ws, removed, tr="REMOVE")
                self._acked -= set(removed)
            if added:
                await self._register_all(ws, added)

    async def _drain(self, ws: _WsLike) -> None:
        """수신 루프 — REAL 디스패치·PING 에코. 끊기면 예외 전파(run이 재시도)."""
        while True:
            raw = await ws.recv()
            await self._dispatch(raw)

    async def _read_until(self, ws: _WsLike, trnm: str) -> dict:
        """지정 trnm 응답까지 수신하며 그 사이 REAL/PING을 처리. 유예 초과 시 TimeoutError."""
        deadline = time.monotonic() + _ACK_TIMEOUT_S
        while True:
            remain = deadline - time.monotonic()
            if remain <= 0:
                raise TimeoutError(f"kiwoom no {trnm} ack in {_ACK_TIMEOUT_S}s")
            raw = await asyncio.wait_for(ws.recv(), timeout=remain)
            msg = await self._dispatch(raw)
            if msg is not None and msg.get("trnm") == trnm:
                return msg

    async def _dispatch(self, raw: str | bytes) -> dict | None:
        """1수신 → JSON 파싱. PING 에코, REAL→on_tick. control 메시지 dict 반환."""
        now_ms = int(time.time() * 1000)
        self.last_recv_ms = now_ms
        if isinstance(raw, bytes):
            raw = raw.decode("utf-8", errors="replace")
        try:
            msg = json.loads(raw)
        except (TypeError, json.JSONDecodeError):
            return None
        trnm = msg.get("trnm")
        if trnm == "PING":
            await self._echo(raw)
            return None
        if trnm == "REAL":
            date = self._date_fn()
            for tick in parse_real_message(msg, date=date, now_ms=now_ms):
                self.last_tick_ms = now_ms
                if self._on_tick is not None:
                    await self._on_tick(tick)
            return None
        return msg

    async def _echo(self, raw: str | bytes) -> None:
        if self._ws is not None:
            await self._ws.send(raw)

    @staticmethod
    def _is_kick(e: Exception) -> bool:
        """close(1000, 'Bye') = 동일 앱키 신규 세션에 의한 축출(실측)."""
        code = getattr(e, "code", None)
        reason = str(getattr(e, "reason", "") or "")
        return code == 1000 and "bye" in reason.lower()  # noqa: PLR2004

    @staticmethod
    async def _safe_close(ws: _WsLike) -> None:
        close = getattr(ws, "close", None)
        if close is None:
            return
        with contextlib.suppress(Exception):
            await close()
