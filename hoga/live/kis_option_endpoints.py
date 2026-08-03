"""KIS 옵션 체인 조회 (KisOptionEndpointsMixin) — 심리 패널 데이터 계층, ADR-0135.

``kis_endpoints.py`` 와 같은 믹스인 규약을 따른다: ``self._get`` 을 KisClient 의
MRO 로 해결하고 자체 상태를 두지 않는다. 옵션은 새 도메인이라 파일을 분리했다
(kis_endpoints.py 는 이미 1,100줄 이상).

**전광판 TR(FHPIF05030100)을 쓰지 않는 이유** — output1/output2 가 각 100건
상한인데 정렬이 행사가 내림차순이라 **한쪽 끝만** 준다. 2026-08-03 실측에서
근월물 행사가 390개 중 응답은 1350.0~1597.5 뿐이었고, 당시 ATM(KOSPI200 ~995)은
내림차순 234번째라 구조적으로 도달할 수 없었다. 그 응답의 풋 100행 거래량 합계는
1계약이었다 — 즉 "잘린 표본"이 아니라 "죽은 구간 전부"다. 그래서 종목별 조회
(FHMIF10000000)로 필요한 행사가를 직접 지정한다.

응답 필드는 실측 확인(2026-08-03): output1 이 시세·미결제·IV·그리스를 모두 싣고,
**output3 에 기초자산 지수가 함께 온다** — KOSPI200 현재가를 위해 별도 TR 을 부를
필요가 없다.
"""
from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from hoga.api.kis_option_master import OptionMasterRow, OptionRight
from hoga.live.kis_errors import KisApiError, KisRateLimitError
from hoga.live.kis_venue import KIS_KST

log = logging.getLogger(__name__)

_OPTION_PRICE_PATH = "/uapi/domestic-futureoption/v1/quotations/inquire-price"
_OPTION_PRICE_TR = "FHMIF10000000"

#: 동시 요청 상한. 유량 자체는 KisClient 의 토큰버킷이 잡으므로 이 값은 커넥션 풀
#: 보호용이다. 체인 전수는 ~780 요청이라 무제한 gather 는 소켓을 폭발시킨다.
_CHAIN_CONCURRENCY = 8


@dataclass(frozen=True)
class OptionQuote:
    """옵션 1종목 스냅샷.

    거래가 없는 종목이 정상적으로 많다(비라운드 행사가는 대부분 거래량 0). 그래서
    volume/oi 0 은 결측이 아니라 실제 값으로 취급한다. 반면 **iv 0.0 은 "값 없음"과
    구분되지 않으므로** 집계에서 스큐를 계산할 때 반드시 0 을 제외해야 한다.
    """
    code: str
    right: OptionRight
    strike: float
    price: float
    volume: int
    open_interest: int
    oi_change: int
    iv: float
    delta: float
    gamma: float
    vega: float
    theta: float


@dataclass(frozen=True)
class OptionChainSnapshot:
    expiry: str
    #: 기초자산(KOSPI200) 지수 — 응답 output3 에서 온다.
    underlying: float
    quotes: tuple[OptionQuote, ...]
    #: 파싱 실패로 버린 종목 수. 0 이 아니면 로그로 드러난다(조용한 축소 방지).
    dropped: int
    t_ms: int


def _num(row: dict[str, Any], key: str) -> float | None:
    v = row.get(key)
    if v is None or v == "":
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


class KisOptionEndpointsMixin:
    async def fetch_option_quote(
        self, row: OptionMasterRow, *, foreground: bool = False
    ) -> tuple[OptionQuote, float] | None:
        """옵션 1종목 시세 (TR FHMIF10000000).

        반환은 ``(quote, underlying)``. 기초자산은 종목마다 같은 값이 오지만 응답
        시각이 달라 미세하게 다르므로, 호출자가 대표값(첫 응답)을 고른다.
        행사가를 못 읽으면 None — 집계의 x축이 없는 행이라 살릴 수 없다.
        """
        body = await self._get(  # type: ignore[attr-defined]
            path=_OPTION_PRICE_PATH,
            tr_id=_OPTION_PRICE_TR,
            params={"FID_COND_MRKT_DIV_CODE": "O", "FID_INPUT_ISCD": row.code},
            foreground=foreground,
        )
        o1 = body.get("output1") or {}
        strike = _num(o1, "acpr")
        if strike is None or strike <= 0:
            return None
        underlying = _num(body.get("output3") or {}, "bstp_nmix_prpr") or 0.0
        quote = OptionQuote(
            code=row.code,
            right=row.right,
            strike=strike,
            price=_num(o1, "futs_prpr") or 0.0,
            volume=int(_num(o1, "acml_vol") or 0),
            open_interest=int(_num(o1, "hts_otst_stpl_qty") or 0),
            oi_change=int(_num(o1, "otst_stpl_qty_icdc") or 0),
            iv=_num(o1, "hts_ints_vltl") or 0.0,
            delta=_num(o1, "delta_val") or 0.0,
            gamma=_num(o1, "gama") or 0.0,
            vega=_num(o1, "vega") or 0.0,
            theta=_num(o1, "theta") or 0.0,
        )
        return quote, underlying

    async def fetch_option_chain(
        self,
        rows: list[OptionMasterRow],
        *,
        expiry: str,
        foreground: bool = False,
    ) -> OptionChainSnapshot:
        """여러 종목을 동시 조회해 체인 스냅샷으로 묶는다.

        개별 종목 실패는 체인 전체를 죽이지 않는다(드롭 카운트로 보고). 다만 전부
        실패하면 빈 체인이 조용히 흘러가므로 호출자가 ``quotes`` 비었는지 봐야 한다.
        """
        sem = asyncio.Semaphore(_CHAIN_CONCURRENCY)

        async def one(row: OptionMasterRow):
            async with sem:
                try:
                    return await self.fetch_option_quote(row, foreground=foreground)
                except (KisApiError, KisRateLimitError) as e:
                    # 종목 단위 실패만 삼킨다. KisAuthError 는 전파 — 토큰이 죽으면
                    # 780종목이 모두 실패하므로, 종목별 경고를 780줄 쌓는 대신
                    # 체인 호출 자체가 즉시 실패하는 편이 맞다.
                    log.warning("옵션 시세 실패 code=%s: %s", row.code, e)
                    return None

        results = await asyncio.gather(*(one(r) for r in rows))
        quotes: list[OptionQuote] = []
        underlying = 0.0
        for res in results:
            if res is None:
                continue
            quote, und = res
            quotes.append(quote)
            if underlying == 0.0 and und > 0:
                underlying = und
        dropped = len(rows) - len(quotes)
        if dropped:
            log.warning("옵션 체인 %d/%d 종목 드롭 expiry=%s", dropped, len(rows), expiry)
        return OptionChainSnapshot(
            expiry=expiry,
            underlying=underlying,
            quotes=tuple(quotes),
            dropped=dropped,
            t_ms=int(datetime.now(KIS_KST).timestamp() * 1000),
        )
