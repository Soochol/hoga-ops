"""KIS WebSocket 클라이언트 — 승인키·개별 TR 구독·PINGPONG·좀비 복구
(`KiwoomWsClient` 브로커-대칭).

**골격은 키움과 다르고, 그래야 한다.** ADR-0116 이 상속 베이스(Template Method)를
명시적으로 금지한다 — KIS 는 `(tr_id, tr_key)` **개별 구독**이고 키움은 배치 REG +
킥(신규 세션이 기존을 축출)이다. 통일하는 것은 **관측성 shape 뿐**이다(규율 3):
`connected` · `last_tick_ms` · `last_recv_ms` · `sub_expected` · `sub_acked` ·
`sub_missing()`. `kiwoom_*` 는 import 하지 않는다(규율 1).

`LiveCollector` Protocol 추출은 **3번째 증권사 때** 한다(ADR-0116, Rule of Three).

이 모듈은 **소켓 수명과 구독 상태만** 책임진다. 프레임 봉투(`0|TR_ID|건수|payload`)를
분해해 `on_frame(tr_id, payload)` 로 넘기고, `^` 구분 필드의 의미는 도메인이 읽는다
(키움이 순수 파싱을 `kiwoom_frames` 로 위임한 것과 같은 경계).

**수명은 상위가 쥔다.** `run()` 은 취소될 때까지 연결을 유지하고 재연결하며, 유휴
정지·세션 리셋 판단은 호출자 몫이다(키움에서 `KiwoomSessionManager` 가 하는 역할).

실측 근거(2026-08-06~07, 실계좌):
- 구독 응답은 `SUBSCRIBE SUCCESS` JSON. **코드 유효성을 검사하지 않는다** — 존재하지
  않는 종목코드도 SUCCESS 를 받고 0틱이다. 그래서 ACK 만으로 실효성을 보장 못 한다
  (키움 REG ACK 와 같은 성질).
- `PINGPONG` 프레임이 주기적으로 온다. **무음이 정상인 표면**이라 틱 부재로는 죽음을
  판정할 수 없어, PINGPONG 을 유일한 liveness 근거로 쓴다.
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import time
from collections.abc import Awaitable, Callable
from typing import Protocol

from hoga.live.kis_approval_provider import (
    KisApprovalProvider,
    KisApprovalTransient,
    KisApprovalUnavailable,
)

log = logging.getLogger(__name__)

_WS_URL = "ws://ops.koreainvestment.com:21000"

#: recv 가 이만큼 조용하면 죽은 소켓으로 보고 재연결한다. 정상 세션은 PINGPONG 이
#: 계속 오므로 3분 무수신은 사실상 사망이고, 오탐해도 비용은 재연결+재구독뿐이다.
_RECV_IDLE_TIMEOUT_S = 180.0

_RECONNECT_BACKOFF_S: tuple[float, ...] = (1.0, 2.0, 5.0, 10.0, 30.0)


class _WsLike(Protocol):
    async def send(self, data: str | bytes, /) -> None: ...
    async def recv(self, /) -> str | bytes: ...
    async def close(self) -> None: ...


class KisWsClient:
    """KIS 실시간 WS 전송. 지금 소비자는 야간 선물(ADR-0141) 하나다.

    ``on_frame`` 은 **데이터 프레임마다** 호출된다 — `(tr_id, payload)`. payload 는
    `^` 로 구분된 원문이고 필드 의미는 도메인이 안다.
    """

    def __init__(
        self,
        approval: KisApprovalProvider,
        *,
        tr_id: str,
        on_frame: Callable[[str, str], None],
        connect: Callable[[str], Awaitable[_WsLike]] | None = None,
        url: str = _WS_URL,
    ) -> None:
        self._approval = approval
        self._tr_id = tr_id
        self._on_frame = on_frame
        self._connect = connect or self._default_connect
        self._url = url
        self._codes: tuple[str, ...] = ()
        self._acked: set[str] = set()

        # ── 관측성 표면 (KiwoomWsClient 미러, ADR-0116 규율 3) ──
        # 의미 분리를 그대로 따른다: last_tick_ms = 데이터 프레임 전용(표시),
        # last_recv_ms = 모든 수신(PINGPONG 포함, watchdog liveness).
        self.last_tick_ms: int | None = None
        self.last_recv_ms: int | None = None
        self.connected: bool = False
        #: 영구 휴면 사유. 자격증명 부재 등 — 재시도해도 같은 것만 들어온다.
        self.unavailable: str | None = None

    @staticmethod
    async def _default_connect(url: str) -> _WsLike:
        import websockets  # noqa: PLC0415 — 지연 import(야간에만 필요)

        # ping_interval=None: 라이브러리 keepalive 를 끄고 벤더 PINGPONG 을 쓴다.
        return await websockets.connect(url, ping_interval=None, max_size=None)  # type: ignore[return-value]

    # ── 관측성 (키움과 같은 이름·같은 뜻) ──

    @property
    def expected_codes(self) -> set[str]:
        """구독 기대 종목 집합 — 파생값(저장 안 함)."""
        return set(self._codes)

    @property
    def sub_expected(self) -> int:
        return len(self._codes)

    @property
    def sub_acked(self) -> int:
        return len(self._acked & self.expected_codes)

    def sub_missing(self) -> list[str]:
        """기대하지만 구독 ACK 미확인 종목.

        **ACK 는 실효성을 보장하지 않는다** — 존재하지 않는 코드도 `SUBSCRIBE SUCCESS`
        를 받는다(실측). 상위 워치독이 이 목록과 무틱 종목을 교차해야 한다.
        """
        return sorted(self.expected_codes - self._acked)

    # ── 수명 ──

    async def run(self, codes: tuple[str, ...]) -> None:
        """취소될 때까지 연결을 유지한다. 유휴 정지 판단은 호출자 몫이다.

        영구 실패(자격증명 부재)는 `unavailable` 을 세우고 **조용히 반환**한다 —
        호출자가 폴링 주기마다 되살리므로, 여기서 warning 을 쓰면 로그 벽이 된다.
        일시 실패는 백오프 사다리를 탄다.
        """
        self._codes = codes
        attempt = 0
        while True:
            try:
                await self._session_once()
                attempt = 0  # 정상 종료(취소 아님)면 백오프를 리셋한다
            except asyncio.CancelledError:
                raise
            except KisApprovalUnavailable as e:
                # 재시도해도 같다. 상위가 이 필드를 읽어 화면에 사유를 싣는다.
                self.unavailable = str(e)
                log.debug("KIS WS 휴면: %s", e)
                return
            except (KisApprovalTransient, Exception) as e:  # noqa: BLE001 — 전송 실패는 재연결로 흡수
                wait = _RECONNECT_BACKOFF_S[min(attempt, len(_RECONNECT_BACKOFF_S) - 1)]
                attempt += 1
                # 배경 재연결은 debug — 30초 폴링에 얹히면 warning 은 로그 벽이 된다.
                log.debug("KIS WS 재연결 %.0fs 후: %s", wait, e)
                await asyncio.sleep(wait)
            finally:
                self.connected = False

    async def _session_once(self) -> None:
        key = await asyncio.to_thread(self._approval.get_key)
        ws = await self._connect(self._url)
        try:
            for code in self._codes:
                await ws.send(self._subscribe_frame(key, code))
            self.connected = True
            self.unavailable = None
            log.info("KIS WS 구독 tr=%s %d종목", self._tr_id, len(self._codes))
            await self._recv_loop(ws)
        finally:
            self.connected = False
            with contextlib.suppress(Exception):
                await ws.close()

    def _subscribe_frame(self, key: str, code: str) -> str:
        return json.dumps(
            {
                "header": {
                    "approval_key": key,
                    "custtype": "P",
                    "tr_type": "1",
                    "content-type": "utf-8",
                },
                "body": {"input": {"tr_id": self._tr_id, "tr_key": code}},
            }
        )

    async def _recv_loop(self, ws: _WsLike) -> None:
        while True:
            raw = await asyncio.wait_for(ws.recv(), timeout=_RECV_IDLE_TIMEOUT_S)
            if isinstance(raw, bytes):
                raw = raw.decode("utf-8", "replace")
            self.last_recv_ms = int(time.time() * 1000)

            if raw.startswith("{"):
                self._on_control(raw)
                if _is_pingpong(raw):
                    await ws.send(raw)
                continue

            parts = raw.split("|")
            if len(parts) < _FRAME_PARTS:
                continue
            tr_id, payload = parts[1], parts[3]
            if tr_id != self._tr_id:
                continue
            self.last_tick_ms = self.last_recv_ms
            self._on_frame(tr_id, payload)

    def _on_control(self, raw: str) -> None:
        """구독 응답·PINGPONG 등 JSON 프레임. ACK 를 관측성에 반영한다."""
        try:
            msg = json.loads(raw)
        except ValueError:
            return
        header = msg.get("header") or {}
        body = msg.get("body") or {}
        tr_key = header.get("tr_key")
        if tr_key and str(body.get("rt_cd", "")) == "0":
            self._acked.add(str(tr_key))


#: 실시간 프레임 모양: `0|TR_ID|건수|payload`. 이보다 짧으면 우리 프레임이 아니다.
_FRAME_PARTS = 4


def _is_pingpong(raw: str) -> bool:
    try:
        return (json.loads(raw).get("header") or {}).get("tr_id") == "PINGPONG"
    except ValueError:
        return False
