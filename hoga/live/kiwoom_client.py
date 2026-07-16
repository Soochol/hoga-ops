"""키움 REST 클라이언트 — 분봉 딥 백필(ka10080) 전용 (ADR-0116, PR-5).

키움 ka10080(주식분봉차트)은 호출당 900봉 + cont_yn walk-back(KIS 120봉/콜 대비 7.5배).
분봉 과거팬 콜드로드의 대안 소스 — 키움우선→KIS폴백 사다리(ADR-0109 문법)에 쓰인다.
출력은 KisCandle(캔들 포트 타입) — 백필이 소스 무관으로 소비. kis_* 수집 모듈은
import하지 않되 KisCandle 모델은 공유 포트라 사용(WsTick과 동형, ADR-0116 규율 1).

TR 유량은 앱키당 ~1/s(실측) — 자체 min-interval 페이싱. 폴링 엔진 불가, 딥 백필 전용.
"""
from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Awaitable, Callable
from datetime import datetime
from typing import Any

import httpx

from hoga.live.kis_models import KisCandle  # 캔들 포트 타입(공유) — kis 수집 로직 아님

from .kiwoom_token_provider import KIWOOM_KST

_log = logging.getLogger(__name__)

_BASE_REAL = "https://api.kiwoom.com"
_CHART_PATH = "/api/dostk/chart"
_API_ID_MINUTE = "ka10080"
_MINUTE_ROWS_KEY = "stk_min_pole_chart_qry"
_DEFAULT_MAX_PAGES = 20  # 900봉×20 ≈ 46거래일 상한(런어웨이 방지)


class KiwoomMinuteError(RuntimeError):
    """ka10080 HTTP/에러바디 — 부분 데이터를 완결로 오인하지 않도록 예외로 전파."""


def _num(raw: str | None) -> int:
    """부호 접두(등락방향) strip 후 정수. 빈/None은 0."""
    s = (raw or "").strip()
    return abs(int(s)) if s else 0


def _row_to_candle(row: dict[str, Any]) -> KisCandle | None:
    """ka10080 1행 → KisCandle. cntr_tm(YYYYMMDDHHMMSS KST) → epoch ms. 불량행은 None.

    가격(cur_prc/open/high/low)은 부호=등락방향이라 abs로 크기만. close=현재가(cur_prc).
    """
    cntr_tm = (row.get("cntr_tm") or "").strip()
    if len(cntr_tm) != 14 or not cntr_tm.isdigit():  # noqa: PLR2004
        return None
    try:
        dt = datetime.strptime(cntr_tm, "%Y%m%d%H%M%S").replace(tzinfo=KIWOOM_KST)
        return KisCandle(
            t_ms=int(dt.timestamp() * 1000),
            open=_num(row.get("open_pric")),
            high=_num(row.get("high_pric")),
            low=_num(row.get("low_pric")),
            close=_num(row.get("cur_prc")),
            volume=_num(row.get("trde_qty")),
        )
    except (ValueError, TypeError):
        return None


class KiwoomClient:
    """키움 분봉 REST — ka10080 walk-back. token_fn은 async bearer 발급(재사용 캐시)."""

    def __init__(
        self,
        *,
        token_fn: Callable[[], Awaitable[str]],
        base_url: str = _BASE_REAL,
        _transport: httpx.AsyncBaseTransport | None = None,
        min_interval_s: float = 1.0,
    ) -> None:
        self._token_fn = token_fn
        self._client = httpx.AsyncClient(base_url=base_url, transport=_transport, timeout=15.0)
        self._min_interval_s = min_interval_s
        self._last_call_mono = 0.0
        self._lock = asyncio.Lock()  # TR 1/s 페이싱 직렬화

    async def aclose(self) -> None:
        await self._client.aclose()

    async def fetch_minute_candles(
        self, code: str, *, until_date: str | None = None, max_pages: int = _DEFAULT_MAX_PAGES,
    ) -> tuple[list[KisCandle], bool]:
        """code의 1분봉을 최근→과거로 walk-back. (candles, complete) 반환.

        complete=True는 **until_date 도달 또는 cont_yn=N 자연 종료**(경계 날짜까지 완전
        수집)를 뜻한다. max_pages 소진으로 until_date 미도달이면 complete=False — 이때
        최과거 경계 날짜는 하루 중간에서 잘린 부분 데이터이므로 호출자가 그 날짜를
        캐시에 저장하면 안 된다(리뷰 C3: 부분 날짜 '완결' 캐시 오염 방지).
        HTTP 오류/에러바디는 _one_page가 예외를 던져 여기서 전파 → 호출자 전량 폴백.
        cont_yn 페이지네이션(next_key에 날짜시각 인코딩). t_ms 오름차순 반환(dedup).
        """
        seen: set[int] = set()
        candles: list[KisCandle] = []
        cont_yn, next_key = "N", ""
        complete = False
        for _page in range(max_pages):
            rows, cont_yn, next_key = await self._one_page(code, cont_yn, next_key)
            reached = False
            for row in rows:
                c = _row_to_candle(row)
                if c is None or c.t_ms in seen:
                    continue
                if until_date is not None and _t_ms_date(c.t_ms) < until_date:
                    reached = True
                    continue
                seen.add(c.t_ms)
                candles.append(c)
            if reached or cont_yn != "Y" or not next_key:
                complete = True
                break
        candles.sort(key=lambda c: c.t_ms)
        return candles, complete

    async def _one_page(
        self, code: str, cont_yn: str, next_key: str,
    ) -> tuple[list[dict], str, str]:
        """ka10080 1페이지 — (rows, 응답 cont-yn, 응답 next-key). 1/s 페이싱.

        비200·return_code≠0은 KiwoomMinuteError를 던진다(리뷰 G4: 침묵 잘림 대신 예외로
        전파해 호출자가 부분 데이터를 완결로 오인·저장하지 않고 전량 KIS 폴백하게 함)."""
        async with self._lock:
            await self._pace()
            token = await self._token_fn()
            resp = await self._client.post(
                _CHART_PATH,
                json={"stk_cd": code, "tic_scope": "1", "upd_stkpc_tp": "1"},
                headers={
                    "Content-Type": "application/json;charset=UTF-8",
                    "api-id": _API_ID_MINUTE,
                    "authorization": f"Bearer {token}",
                    "cont-yn": cont_yn,
                    "next-key": next_key,
                },
            )
            self._last_call_mono = time.monotonic()
        if resp.status_code != 200:  # noqa: PLR2004
            raise KiwoomMinuteError(f"ka10080 HTTP {resp.status_code} code={code}")
        body = resp.json()
        rc = body.get("return_code")
        if rc not in (0, None):
            raise KiwoomMinuteError(f"ka10080 return_code={rc} code={code}")
        rows = body.get(_MINUTE_ROWS_KEY) or []
        return rows, resp.headers.get("cont-yn", "N"), resp.headers.get("next-key", "")

    async def _pace(self) -> None:
        """직전 호출로부터 min_interval_s 경과 보장(TR 1/s 실측)."""
        if self._min_interval_s <= 0:
            return
        wait = self._min_interval_s - (time.monotonic() - self._last_call_mono)
        if wait > 0:
            await asyncio.sleep(wait)


def _t_ms_date(t_ms: int) -> str:
    return datetime.fromtimestamp(t_ms / 1000, tz=KIWOOM_KST).strftime("%Y%m%d")
