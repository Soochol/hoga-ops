"""옵션 심리 패널 2계층 수집 런타임 (ADR-0135).

**왜 2계층인가** — 지표마다 필요한 커버리지가 다르다.

    전수 계층 (5분)   : 근월물 780종목. Max Pain·GEX 는 전 행사가 합산이라 필수.
                        실측 60.7초 소요(12.9 req/s)라 고빈도로 돌 수 없다.
    ATM 계층 (30초)   : ATM ±20 행사가 ~82종목. P/C 비율·IV 스큐용.

**왜 요청 구동인가** — 아무도 안 보는 동안 780종목을 5분마다 긁으면 KIS 유량을
/live 와 나눠 쓰는 의미가 없다. 첫 요청이 루프를 깨우고, 마지막 요청 후
``_IDLE_STOP_S`` 동안 조용하면 스스로 멈춘다.

응답에는 **계층별 as_of 를 따로 싣는다**. 하나로 뭉치면 5분 전 GEX 와 30초 전
P/C 가 같은 시각으로 표시되어 오독을 부른다.
"""
from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from dataclasses import dataclass
from datetime import datetime

from hoga.api.kis_option_master import (
    KisOptionMasterFetchError,
    OptionMasterRow,
    atm_window,
    fetch_option_master,
    near_month_chain,
)
from hoga.live.kis_option_endpoints import OptionChainSnapshot
from hoga.live.kis_venue import KIS_KST

log = logging.getLogger(__name__)

_FULL_INTERVAL_S = 300.0
_ATM_INTERVAL_S = 30.0
#: 마지막 요청 후 이만큼 조용하면 루프를 멈춘다(유량 회수).
_IDLE_STOP_S = 600.0
#: 마스터는 하루 단위로 바뀐다 — 일중 재다운로드는 낭비다.
_MASTER_TTL_S = 6 * 3600.0
_ATM_WIDTH = 20


@dataclass(frozen=True)
class SentimentState:
    """스냅샷 + 각 계층의 관측 시각. 계층이 아직 없으면 None."""
    full: OptionChainSnapshot | None
    atm: OptionChainSnapshot | None
    full_at_ms: int | None
    atm_at_ms: int | None
    expiry: str | None
    #: 휴면 사유(자격증명 없음·마스터 실패 등). None 이면 정상.
    unavailable: str | None


def _now_ms() -> int:
    return int(datetime.now(KIS_KST).timestamp() * 1000)


class OptionSentimentRuntime:
    """프로세스 싱글턴. ``request()`` 가 루프를 깨우고 ``state()`` 가 캐시를 읽는다."""

    def __init__(self, client_factory) -> None:
        # client_factory: () -> KisClient | None  (자격증명 없으면 None)
        self._client_factory = client_factory
        self._task: asyncio.Task | None = None
        self._lock = asyncio.Lock()
        self._last_request = 0.0
        self._master: list[OptionMasterRow] | None = None
        self._master_at = 0.0
        self._full: OptionChainSnapshot | None = None
        self._atm: OptionChainSnapshot | None = None
        self._full_at: int | None = None
        self._atm_at: int | None = None
        self._expiry: str | None = None
        self._unavailable: str | None = None

    def state(self) -> SentimentState:
        return SentimentState(
            full=self._full,
            atm=self._atm,
            full_at_ms=self._full_at,
            atm_at_ms=self._atm_at,
            expiry=self._expiry,
            unavailable=self._unavailable,
        )

    async def request(self) -> None:
        """요청이 왔음을 알리고 루프가 돌고 있게 만든다.

        자격증명이 없으면 **태스크를 띄우지 않는다**. 30초마다 깨어나 아무것도 못
        하고 다시 자는 루프는 낭비이고, 테스트에서는 이 루프가 살아남아 다른
        테스트의 전역 KIS 상태를 오염시킨다. 팩토리는 요청마다 다시 확인하므로
        나중에 .env 가 채워지면 다음 요청에서 정상 기동한다.
        """
        self._last_request = time.monotonic()
        if self._client_factory() is None:
            self._unavailable = "kis_credentials_missing"
            return
        async with self._lock:
            if self._task is None or self._task.done():
                self._task = asyncio.create_task(self._loop())

    async def aclose(self) -> None:
        async with self._lock:
            task, self._task = self._task, None
        if task is not None and not task.done():
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task

    async def _ensure_master(self) -> list[OptionMasterRow]:
        if self._master is not None and time.monotonic() - self._master_at < _MASTER_TTL_S:
            return self._master
        rows = await asyncio.to_thread(fetch_option_master)
        self._master = rows
        self._master_at = time.monotonic()
        return rows

    async def _loop(self) -> None:
        next_full = 0.0
        next_atm = 0.0
        try:
            while time.monotonic() - self._last_request < _IDLE_STOP_S:
                client = self._client_factory()
                if client is None:
                    self._unavailable = "kis_credentials_missing"
                    await asyncio.sleep(_ATM_INTERVAL_S)
                    continue
                try:
                    master = await self._ensure_master()
                    expiry, chain = near_month_chain(master)
                except KisOptionMasterFetchError as e:
                    self._unavailable = "option_master_unavailable"
                    log.warning("옵션 마스터 실패: %s", e)
                    await asyncio.sleep(_ATM_INTERVAL_S)
                    continue
                self._expiry = expiry
                self._unavailable = None

                now = time.monotonic()
                if now >= next_full:
                    # 전수가 먼저다 — ATM 창을 고르려면 기초자산 지수가 필요하고,
                    # 그 값은 체인 응답에 실려 온다(별도 TR 없이).
                    snap = await client.fetch_option_chain(chain, expiry=expiry)
                    if snap.quotes:
                        self._full, self._full_at = snap, _now_ms()
                    next_full = time.monotonic() + _FULL_INTERVAL_S
                elif now >= next_atm and self._full is not None:
                    window = atm_window(chain, self._full.underlying, width=_ATM_WIDTH)
                    snap = await client.fetch_option_chain(window, expiry=expiry)
                    if snap.quotes:
                        self._atm, self._atm_at = snap, _now_ms()
                    next_atm = time.monotonic() + _ATM_INTERVAL_S
                else:
                    await asyncio.sleep(1.0)
        except asyncio.CancelledError:
            raise
        except Exception:
            # 루프가 조용히 죽으면 UI 는 영원히 낡은 값을 보여준다 — 사유를 남기고
            # 상태에도 실어 다음 request() 가 새 태스크를 띄우게 한다.
            log.exception("옵션 심리 수집 루프 실패")
            self._unavailable = "collector_failed"
            raise


_runtime: OptionSentimentRuntime | None = None


def get_runtime(client_factory) -> OptionSentimentRuntime:
    global _runtime  # noqa: PLW0603 — 문서화된 프로세스 싱글턴
    if _runtime is None:
        _runtime = OptionSentimentRuntime(client_factory)
    return _runtime


def reset_runtime_for_tests() -> None:
    global _runtime  # noqa: PLW0603 — 테스트 격리
    _runtime = None
