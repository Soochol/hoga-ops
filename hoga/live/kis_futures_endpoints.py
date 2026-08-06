"""KIS 지수선물 시세 조회 (`KisFuturesEndpointsMixin`) — `/market` 선물 토글.

``kis_option_endpoints.py`` 와 같은 믹스인 규약을 따른다: ``self._get`` 을 KisClient 의
MRO 로 해결하고 자체 상태를 두지 않는다.

**베이시스는 `mrkt_basis` 다 — `basis` 가 아니다.** 응답에 둘 다 오는데 뜻이 다르고,
잘못 고르면 부호까지 뒤집힌다(2026-08-06 실측):

    KOSPI200   futs_prpr 981.15  hts_thpr 985.07  기초 982.92
               basis  +2.15  = 이론가 − 기초자산  (이론 베이시스)
               mrkt_basis −1.77 = 선물   − 기초자산  (시장 베이시스)  ← 화면이 쓰는 값

**`output3` 의 기초지수는 쓰지 않는다.** 옵션 경로는 "기초자산이 함께 와서 별도 TR 이
불필요" 한 것이 이점이었지만, 선물에서는 **코스닥150·VKOSPI 를 조회해도 output3 이
KOSPI200 을 준다**(같은 실측: 코스닥150 조회에도 982.92). 그걸로 베이시스를 직접 빼면
382.88 같은 쓰레기가 나온다. 벤더가 이미 `mrkt_basis` 로 옳게 계산해 주므로 그 값을
그대로 흘려보낸다.
"""
from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from hoga.api.kis_futures_master import FuturesMasterRow
from hoga.live.kis_errors import KisApiError, KisRateLimitError
from hoga.util.timeenc import KST

log = logging.getLogger(__name__)

_PRICE_PATH = "/uapi/domestic-futureoption/v1/quotations/inquire-price"
_PRICE_TR = "FHMIF10000000"

_MINUTE_PATH = "/uapi/domestic-futureoption/v1/quotations/inquire-time-fuopchartprice"
_MINUTE_TR = "FHKIF03020200"

#: 봉 간격(초). **5분이어야 당일 전체가 들어온다** — 이 TR 은 102건 상한이라
#: 1분봉이면 13:54~15:45 만 오고(실측 102건) 스파크라인이 하루의 1/4만 그린다.
#: 5분봉은 83건으로 08:45~15:45 전 구간을 덮는다(2026-08-06 실측).
_MINUTE_INTERVAL_S = "300"

#: 조회 기준 시각 = 주간 마감(15:45). 여기서부터 **과거로** 채워지므로 장중에
#: 미래 시각을 넣어도 "지금까지" 만 온다. 현재 시각을 쓰면 매 호출마다 파라미터가
#: 달라져 상위 캐시 키가 흔들리므로 고정값이 낫다.
_MINUTE_ANCHOR_HHMMSS = "154500"

#: 한 점짜리 선은 거짓 정보라 그리지 않는다 — 현물 `Sparkline` 과 같은 기준.
_MIN_SPARK_BARS = 2

#: 라인업이 3~4종목이라 동시성 상한은 커넥션 풀 보호용으로만 둔다(유량은 토큰버킷 담당).
_CONCURRENCY = 4


@dataclass(frozen=True)
class FuturesQuote:
    """선물 1종목 스냅샷.

    ``value`` 가 None 인 상태는 만들지 않는다 — 시세를 못 읽으면 행 자체를 버린다.
    0 으로 채우면 "선물이 0원" 이라는 거짓말이 되고, 카드가 그걸 그대로 그린다.
    """
    code: str
    product: str
    label: str
    expiry: str
    value: float
    change: float
    change_rate: float
    prev_close: float
    volume: int
    open_interest: int
    oi_change: int
    #: 시장 베이시스(선물 − 기초자산). `basis`(이론 베이시스)와 다르다 — 모듈 docstring 참조.
    market_basis: float | None
    #: 괴리율(%). 이론가 대비.
    disparity: float | None
    #: 최종거래일까지 남은 일수. 롤오버가 임박했는지를 화면이 보여줄 근거다.
    days_left: int | None
    last_trade_date: str | None
    t_ms: int


@dataclass(frozen=True)
class FuturesSpark:
    """스파크라인 1개분. `closes` 는 **시간순**(과거→최신)이다."""
    code: str
    closes: tuple[float, ...]
    #: 당일 시가 — 색 기준선. 현물 카드가 `bars[0].open` 을 쓰는 것과 같은 규칙이다.
    day_open: float | None


def _num(row: dict[str, Any], key: str) -> float | None:
    v = row.get(key)
    if v is None or v == "":
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


class KisFuturesEndpointsMixin:
    async def fetch_futures_quote(
        self, row: FuturesMasterRow, *, foreground: bool = False
    ) -> FuturesQuote | None:
        """선물 1종목 시세 (TR ``FHMIF10000000``).

        가격을 못 읽으면 None — 카드의 주 숫자가 없는 행은 살릴 수 없다.

        **빈 응답을 성공으로 오인하지 않도록 가격으로 판정한다.** KIS 는 존재하지 않는
        종목코드에도 ``rt_cd=0`` "정상처리" + 전 필드 빈 문자열을 준다(fail-open).
        rt_cd 만 보면 롤오버로 사라진 월물을 계속 정상으로 읽는다.
        """
        body = await self._get(  # type: ignore[attr-defined]
            path=_PRICE_PATH,
            tr_id=_PRICE_TR,
            params={"FID_COND_MRKT_DIV_CODE": "F", "FID_INPUT_ISCD": row.code},
            foreground=foreground,
        )
        o1 = body.get("output1") or {}
        price = _num(o1, "futs_prpr")
        if price is None or price <= 0:
            return None
        days_left = _num(o1, "hts_rmnn_dynu")
        last_dt = str(o1.get("futs_last_tr_date") or "").strip() or None
        return FuturesQuote(
            code=row.code,
            product=row.product,
            label=row.name,
            expiry=row.expiry,
            value=price,
            change=_num(o1, "futs_prdy_vrss") or 0.0,
            change_rate=_num(o1, "futs_prdy_ctrt") or 0.0,
            prev_close=_num(o1, "futs_prdy_clpr") or 0.0,
            volume=int(_num(o1, "acml_vol") or 0),
            open_interest=int(_num(o1, "hts_otst_stpl_qty") or 0),
            oi_change=int(_num(o1, "otst_stpl_qty_icdc") or 0),
            market_basis=_num(o1, "mrkt_basis"),
            disparity=_num(o1, "dprt"),
            days_left=int(days_left) if days_left is not None else None,
            last_trade_date=last_dt,
            t_ms=int(datetime.now(KST).timestamp() * 1000),
        )

    async def fetch_futures_spark(
        self, row: FuturesMasterRow, *, date_yyyymmdd: str, foreground: bool = False
    ) -> FuturesSpark | None:
        """당일 5분봉 종가 배열 (TR ``FHKIF03020200``) — 카드 스파크라인용.

        응답 `output2` 는 **최신→과거** 순이라 뒤집어서 시간순으로 돌려준다. 안 뒤집으면
        스파크라인이 좌우 반전되는데, 우상향이 우하향으로 보일 뿐 **에러가 아니라서**
        눈으로만 잡힌다.

        2봉 미만이면 None — 한 점짜리 선은 거짓 정보라 그리지 않는다(현물 카드와 같은 규칙).
        """
        body = await self._get(  # type: ignore[attr-defined]
            path=_MINUTE_PATH,
            tr_id=_MINUTE_TR,
            params={
                "FID_COND_MRKT_DIV_CODE": "F",
                "FID_INPUT_ISCD": row.code,
                "FID_HOUR_CLS_CODE": _MINUTE_INTERVAL_S,
                "FID_PW_DATA_INCU_YN": "N",
                "FID_FAKE_TICK_INCU_YN": "N",
                "FID_INPUT_DATE_1": date_yyyymmdd,
                "FID_INPUT_HOUR_1": _MINUTE_ANCHOR_HHMMSS,
            },
            foreground=foreground,
        )
        rows_out = body.get("output2") or []
        closes: list[float] = []
        for bar in reversed(rows_out):
            close = _num(bar, "futs_prpr")
            if close is not None and close > 0:
                closes.append(close)
        if len(closes) < _MIN_SPARK_BARS:
            return None
        # 시가는 첫 봉의 시가 — 스파크라인 기준선(색 판정)이다.
        first_open = _num(rows_out[-1], "futs_oprc") if rows_out else None
        return FuturesSpark(code=row.code, closes=tuple(closes), day_open=first_open)

    async def fetch_futures_quotes(
        self, rows: list[FuturesMasterRow], *, foreground: bool = False
    ) -> list[FuturesQuote]:
        """라인업을 동시 조회. 개별 실패는 그 행만 버린다(부분 응답이 정상 경로).

        ``KisAuthError`` 는 전파한다 — 토큰이 죽으면 전 종목이 같은 이유로 실패하므로,
        종목별 경고를 쌓는 대신 호출 자체가 실패하는 편이 진단에 낫다
        (옵션 체인이 같은 판단을 한다).
        """
        sem = asyncio.Semaphore(_CONCURRENCY)

        async def one(row: FuturesMasterRow) -> FuturesQuote | None:
            async with sem:
                try:
                    return await self.fetch_futures_quote(row, foreground=foreground)
                except (KisApiError, KisRateLimitError) as e:
                    log.warning("선물 시세 실패 code=%s: %s", row.code, e)
                    return None

        results = await asyncio.gather(*(one(r) for r in rows))
        return [q for q in results if q is not None]
