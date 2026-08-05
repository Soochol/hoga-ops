"""시장 종합(`/market`) 읽기 전용 API (#1121).

**저장 축과 분리돼 있다.** 여기 표면들은 놓친 폴링의 대가가 잠깐의 낡음뿐이라
수요 구동 TTL 로 충분하다 — 결손이 영구 구멍인 장중 수급만 서버가 무조건 적재한다
(`investor_flow_collector`, #1099).

캐시 규약은 `_get_index_quotes`(live/api.py)의 확립된 패턴을 그대로 따른다:

1. 스냅샷은 **캐시만** 보고 만든다 — 자격증명·용량이 없어도 last-good 을 돌려준다.
2. `asyncio.Lock` 이 곧 단일비행. TTL 재확인은 **락 안에서** 한다.
3. 실패해도 last-good 을 **축출하지 않고**, `fetched_at` 은 갱신한다 — 업스트림이
   죽었을 때 TTL 주기로만 재시도하고 뜨거운 루프에 빠지지 않는다.
4. 로그는 `debug` — 배경 폴링의 실패를 warning 으로 남기면 로그 벽이 된다.

유량은 제약이 아니다: 버킷이 `(앱키, TR)` 당 5 req/s 이고 신규 TR 은 전부 자기 창구를
새로 받는다(#1015·ADR-0138). 그래도 우선순위는 `background` 다 — 클릭 응답이 아니라
주기 폴링이므로 사용자 조작에 양보하는 쪽이 맞다.
"""
from __future__ import annotations

import asyncio
import logging
import time
from pathlib import Path
from typing import Any

from fastapi import APIRouter

from hoga.live import kiwoom_access, market_overview

log = logging.getLogger(__name__)

# TTL 은 벤더 갱신 주기와 화면 위치가 정한다(#1099) — 유량이 정하지 않는다.
TTL_SECTORS_S = 30.0      # 지수·등락종목수: 화면 최상단
TTL_PROGRAM_S = 60.0      # 100행 ≈ 100분이라 자기 백필 — 주기는 신선도 문제일 뿐
TTL_STREAKS_S = 300.0     # 연속일수는 일 단위 축
TTL_BREADTH_S = 300.0     # 52주 신고·신저는 느리게 움직인다

_MARKETS = ("0", "1")  # 코스피 · 코스닥 — 별도 콜이다
_STEX_ALL = "3"


class _TtlCache:
    """TTL + 단일비행 + last-good. 네 규약(모듈 docstring)을 한 곳에 봉인한다."""

    def __init__(self, ttl_s: float) -> None:
        self._ttl_s = ttl_s
        self._value: Any = None
        self._fetched_at = float("-inf")
        self._lock = asyncio.Lock()

    @property
    def value(self) -> Any:
        return self._value

    async def get(self, fetch: Any) -> Any:
        now = time.monotonic()
        if now - self._fetched_at < self._ttl_s and self._value is not None:
            return self._value
        async with self._lock:
            # 락 안에서 재확인 — 대기 중에 다른 코루틴이 이미 채웠을 수 있다.
            now = time.monotonic()
            if now - self._fetched_at < self._ttl_s and self._value is not None:
                return self._value
            try:
                fresh = await fetch()
            except Exception as e:  # noqa: BLE001 — 배경 폴링의 실패는 last-good 으로 흡수한다.
                log.debug("market_routes.fetch_failed error=%s", e)
                self._fetched_at = time.monotonic()  # 뜨거운 재시도 루프 방지
                return self._value
            if fresh is not None:
                self._value = fresh
            self._fetched_at = time.monotonic()
            return self._value


def build_router(*, data_dir: Path) -> APIRouter:
    router = APIRouter(prefix="/api/market", tags=["market"])

    sectors_cache = _TtlCache(TTL_SECTORS_S)
    # 축마다 캐시가 갈려야 한다 — 한 캐시를 공유하면 당일/일별 토글이 서로의 값을 지운다.
    program_cache = _TtlCache(TTL_PROGRAM_S)
    daily_program_cache = _TtlCache(TTL_PROGRAM_S)
    streaks_cache = _TtlCache(TTL_STREAKS_S)

    def _seam() -> tuple[Any, Any] | None:
        """(거버너, 클라이언트). 무자격이면 None — 라우트는 빈 응답을 돌려준다."""
        from hoga.live import kiwoom_rest_runtime  # noqa: PLC0415 — 지연 import(heavy·시임)

        client = kiwoom_rest_runtime.ensure_rest_client(data_dir)
        if client is None:
            return None
        return kiwoom_rest_runtime.ensure_scheduler(data_dir), client

    async def _call(api_id: str, body: dict[str, str], *, key: tuple) -> list[dict[str, Any]] | None:
        seam = _seam()
        if seam is None:
            return None
        scheduler, client = seam
        page = await kiwoom_access.run_with_capacity(
            scheduler,
            key=key,
            api_id=api_id,
            priority="background",
            client=client,
            # 기본인자 바인딩 — late binding 이면 모든 호출이 마지막 body 를 본다.
            fetch_fn=lambda c, b=body: c.call(api_id, b),
        )
        return list(getattr(page, "rows", []) or [])

    @router.get("/sectors")
    async def get_sectors() -> dict[str, Any]:
        """지수 값 + **등락종목수** + KRX 업종 (ka20003, 시장별 1콜).

        등락종목수는 종합지수(001/101)에만 싣는다(#1100) — 지수 상품(코스피200·
        코스닥150)에는 표시 규칙상 붙이지 않는다. 코스피200 은 벤더에 값 자체가 없다.
        """

        async def _fetch() -> dict[str, Any]:
            out: dict[str, Any] = {"markets": {}}
            for mrkt_tp in _MARKETS:
                inds_cd = "001" if mrkt_tp == "0" else "101"
                rows = await _call(
                    "ka20003",
                    {"mrkt_tp": mrkt_tp, "inds_cd": inds_cd},
                    key=("market-sectors", mrkt_tp),
                )
                if rows is None:
                    continue
                parsed = market_overview.parse_index_sectors(rows)
                out["markets"][mrkt_tp] = {
                    "index": next(
                        (
                            {
                                "code": b.code, "name": b.name, "value": b.value,
                                "change_pct": b.change_pct, "rising": b.rising,
                                "falling": b.falling, "flat": b.flat,
                                "upper": b.upper, "lower": b.lower,
                            }
                            for b in parsed if b.is_whole_market
                        ),
                        None,
                    ),
                    # 업종 행에는 등락종목수를 싣지 않는다 — 화면이 쓰지 않는다.
                    "sectors": [
                        {"code": b.code, "name": b.name, "value": b.value,
                         "change_pct": b.change_pct}
                        for b in parsed if not b.is_whole_market
                    ],
                }
            return out

        return await sectors_cache.get(_fetch) or {"markets": {}}

    @router.get("/program")
    async def get_program(axis: str = "intraday") -> dict[str, Any]:
        """프로그램 매매 추이. `axis=intraday`(ka90005) | `daily`(ka90010).

        ⚠ 두 TR 은 응답 스키마가 같고 **`kospi200` 스케일만 다르다** — 파서에
        `kospi200_scaled` 를 명시적으로 넘기는 이유다(기본값을 두지 않았다).
        """
        api_id = "ka90005" if axis == "intraday" else "ka90010"
        scaled = axis == "intraday"

        async def _fetch() -> dict[str, Any]:
            from hoga.collector.orchestrator import now_kst  # noqa: PLC0415

            date = now_kst().strftime("%Y%m%d")
            out: dict[str, Any] = {"axis": axis, "markets": {}}
            for mrkt_tp, label in (("P00101", "KOSPI"), ("P10102", "KOSDAQ")):
                rows = await _call(
                    api_id,
                    {"date": date, "amt_qty_tp": "1", "mrkt_tp": mrkt_tp,
                     "min_tic_tp": "0" if scaled else "1", "stex_tp": _STEX_ALL},
                    key=("market-program", api_id, mrkt_tp),
                )
                if rows is None:
                    continue
                out["markets"][label] = market_overview.parse_program_trend(
                    rows, kospi200_scaled=scaled
                )
            return out

        cache = program_cache if axis == "intraday" else daily_program_cache
        return await cache.get(_fetch) or {"axis": axis, "markets": {}}

    @router.get("/streaks")
    async def get_streaks() -> dict[str, Any]:
        """연속 순매수 — **한 콜이 외국인·기관 두 카드**를 채운다(ka10131, #1096)."""

        async def _fetch() -> dict[str, Any]:
            rows = await _call(
                "ka10131",
                {"dt": "1", "mrkt_tp": "001", "netslmt_tp": "2", "stk_inds_tp": "0",
                 "amt_qty_tp": "0", "stex_tp": _STEX_ALL},
                key=("market-streaks",),
            )
            if rows is None:
                return {"외국인": [], "기관": []}
            return {
                actor: market_overview.parse_streaks(rows, actor=actor)
                for actor in ("외국인", "기관")
            }

        return await streaks_cache.get(_fetch) or {"외국인": [], "기관": []}

    return router
