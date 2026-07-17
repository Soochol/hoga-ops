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
from .ticks import WsTick  # 포트 계약 타입(공유)

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
        on_tick: Callable[[WsTick], Awaitable[None]] | None,
        date_fn: Callable[[], str],
        url: str = WS_URL_REAL,
        types: tuple[str, ...] = DEFAULT_TYPES,
        gate_fn: Callable[[], bool] | None = None,
        max_consecutive_kicks: int = 5,
        invalidate_fn: Callable[[], None] | None = None,
        _connect: Callable[[str], Awaitable[_WsLike]] | None = None,
    ) -> None:
        self._token_fn = token_fn
        # LOGIN rc!=0(토큰 거부) 시 호출 — 캐시 토큰을 무효화해 다음 재연결이 신선 토큰을
        # 받게 한다(리뷰 Major: 없으면 stale 토큰으로 최대 24h 재연결 루프). provider의
        # 60s 발급 쿨다운은 유지돼 발급 폭주를 막는다(WS 백오프와 함께 ~1분 내 복구).
        self._invalidate_fn = invalidate_fn
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
        self._acked: set[str] = set()  # REG rc=0 받은 종목 (실등록 여부는 틱 유입 워치독)
        # ACK 라우팅(리뷰 C1): _recv_loop이 유일한 recv 소유자다. LOGIN/REG/REMOVE ACK는
        # 여기 Future로 라우팅되고 sender(_login/_reg_batch)가 await한다 — sender가 직접
        # recv를 걸지 않으므로 websockets의 동시 recv 금지(ConcurrencyError)를 구조적으로
        # 회피한다(KIS ws_client의 단일 _recv_loop 미러).
        self._ack_waiters: dict[str, asyncio.Future[dict]] = {}
        # 재연결/킥 상태 — _session_once가 연결 성공 시 리셋(리뷰: run()의 리셋은
        # _session_once가 정상 return 안 해 dead code였음. 연결 성공 시점에 리셋한다).
        self._attempt = 0
        self._consecutive_kicks = 0
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
        self._attempt = 0
        self._consecutive_kicks = 0
        while True:
            if self._gate_fn is not None and not await asyncio.to_thread(self._gate_fn):
                self.connected = False
                await asyncio.sleep(30)
                continue
            try:
                await self._session_once()
            except asyncio.CancelledError:
                self.connected = False
                raise
            except Exception as e:  # noqa: BLE001 — 연결 오류는 전부 재시도 대상
                self.connected = False
                self._ws = None
                if self._is_kick(e):
                    self._consecutive_kicks += 1
                    if self._consecutive_kicks >= self._max_kicks:
                        self.kicked_by_peer = True
                        _log.error(
                            "live.kiwoom.kicked_by_peer kicks=%d — 다른 프로세스가 "
                            "앱키 점유. 정지.", self._consecutive_kicks,
                        )
                        return
                    delay = _BACKOFF_S[min(self._attempt, len(_BACKOFF_S) - 1)]
                    self._attempt += 1
                    _log.warning("live.kiwoom.kicked attempt=%d delay=%ds",
                                 self._attempt, delay)
                else:
                    delay = _BACKOFF_S[min(self._attempt, len(_BACKOFF_S) - 1)]
                    self._attempt += 1
                    _log.warning("live.kiwoom.reconnect attempt=%d delay=%ds err=%r",
                                 self._attempt, delay, e)
                await asyncio.sleep(delay)

    async def _session_once(self) -> None:
        """1세션: connect → recv 루프 기동 → LOGIN → 전 종목 배치 REG → drain(recv 루프
        await). recv 소유는 _recv_loop 하나 — LOGIN/REG는 send 후 ACK Future를 await한다.
        연결 성공(LOGIN) 시 재연결/킥 카운터를 리셋(정상 return 없어 run()에선 dead code였음)."""
        token = await self._token_fn()
        ws = await self._connect(self._url)
        recv_task = asyncio.create_task(self._recv_loop(ws))
        try:
            async with self._sub_lock:
                self._ws = ws
                self._acked.clear()
                self.sub_rejected = 0
                self._reject_all_waiters(RuntimeError("new session"))
                await self._login(ws, token)
                self.connected = True
                self._attempt = 0
                self._consecutive_kicks = 0
                await self._register_all(ws, list(self._codes))
            _log.info("live.kiwoom.connected codes=%d acked=%d",
                      len(self._codes), len(self._acked))
            # drain: recv 루프가 연결 종료(예외)로 끝날 때까지 대기 → run()이 재연결.
            await recv_task
        finally:
            self.connected = False
            self._ws = None
            recv_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await recv_task
            self._reject_all_waiters(ConnectionError("session ended"))
            await self._safe_close(ws)

    async def _recv_loop(self, ws: _WsLike) -> None:
        """유일한 recv 소유자 — REAL→on_tick·PING 에코·control ACK→Future 라우팅.
        연결 종료 시 예외 전파(_session_once가 잡아 재연결)."""
        while True:
            raw = await ws.recv()
            await self._dispatch(raw)

    async def _login(self, ws: _WsLike, token: str) -> None:
        ack = await self._send_and_wait(
            ws, json.dumps({"trnm": "LOGIN", "token": token}), "LOGIN",
        )
        rc = ack.get("return_code")
        if rc != _RC_OK:
            if self._invalidate_fn is not None:
                with contextlib.suppress(Exception):
                    self._invalidate_fn()  # 거부 토큰 캐시 무효화 → 다음 재연결이 재발급
            raise RuntimeError(f"kiwoom LOGIN failed rc={rc} {ack.get('return_msg')!r}")

    async def _register_all(self, ws: _WsLike, codes: list[str]) -> None:
        """전 종목을 배치(50)로 REG. 성공(rc=0) 배치만 _acked에 추가 — 거부/유량소진 배치는
        미기록으로 남겨 sub_missing 워치독에 잡히게 한다(리뷰: 무조건 acked 오마킹 수정)."""
        for start in range(0, len(codes), _REG_BATCH):
            chunk = codes[start : start + _REG_BATCH]
            try:
                ok = await self._reg_batch(ws, chunk, tr="REG")
            except KiwoomSlotCapReached:
                _log.warning("live.kiwoom.slot_cap acked=%d requested=%d",
                             len(self._acked), len(codes))
                break
            if ok:
                self._acked.update(chunk)
            await asyncio.sleep(_REG_PACING_S)

    async def _reg_batch(self, ws: _WsLike, chunk: list[str], *, tr: str) -> bool:
        """1배치 REG/REMOVE 송신 + ACK 대기. rc=OK면 True. 유량 rc는 백오프 재시도,
        슬롯 상한은 KiwoomSlotCapReached, 그 외 거부·유량소진은 False(미등록)."""
        msg = json.dumps({
            "trnm": tr, "grp_no": "1", "refresh": "1",
            "data": [{"item": chunk, "type": self._types}],
        })
        for attempt in range(_MAX_RATE_RETRY):
            ack = await self._send_and_wait(ws, msg, tr)
            rc = ack.get("return_code")
            if rc == _RC_OK:
                return True
            if rc == _RC_RATE_LIMIT:
                await asyncio.sleep(1.0 + attempt)
                continue
            if rc in _RC_SLOT_CAP:
                raise KiwoomSlotCapReached(str(ack.get("return_msg")))
            self.sub_rejected += 1
            _log.warning("live.kiwoom.reg_rejected rc=%s msg=%s", rc, ack.get("return_msg"))
            return False
        _log.warning("live.kiwoom.reg_rate_limited_persist chunk=%d", len(chunk))
        return False

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

    async def _send_and_wait(self, ws: _WsLike, msg: str, trnm: str) -> dict:
        """control 프레임 송신 후 그 trnm ACK를 Future로 대기(recv 루프가 채운다).
        waiter 등록을 send **전에** 해 ACK가 send 직후 도착해도 유실 없다. 같은 trnm의
        이전 대기자는 send 직렬화(_sub_lock)로 없다. 유예 초과 시 TimeoutError."""
        fut: asyncio.Future[dict] = asyncio.get_running_loop().create_future()
        self._ack_waiters[trnm] = fut
        try:
            await ws.send(msg)
            return await asyncio.wait_for(fut, timeout=_ACK_TIMEOUT_S)
        finally:
            if self._ack_waiters.get(trnm) is fut:
                del self._ack_waiters[trnm]

    def _reject_all_waiters(self, exc: BaseException) -> None:
        for fut in list(self._ack_waiters.values()):
            if not fut.done():
                fut.set_exception(exc)
        self._ack_waiters.clear()

    async def _dispatch(self, raw: str | bytes) -> None:
        """1수신 → JSON 파싱. PING 에코, REAL→on_tick, control ACK→대기 Future 라우팅."""
        now_ms = int(time.time() * 1000)
        self.last_recv_ms = now_ms
        if isinstance(raw, bytes):
            raw = raw.decode("utf-8", errors="replace")
        try:
            msg = json.loads(raw)
        except (TypeError, json.JSONDecodeError):
            return
        trnm = msg.get("trnm")
        if trnm == "PING":
            await self._echo(raw)
            return
        if trnm == "REAL":
            date = self._date_fn()
            for tick in parse_real_message(msg, date=date, now_ms=now_ms):
                self.last_tick_ms = now_ms
                if self._on_tick is not None:
                    await self._on_tick(tick)
            return
        # control (LOGIN/REG/REMOVE ACK) → 대기 중인 sender에게 전달.
        waiter = self._ack_waiters.pop(trnm, None) if isinstance(trnm, str) else None
        if waiter is not None and not waiter.done():
            waiter.set_result(msg)

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
