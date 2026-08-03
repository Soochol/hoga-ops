"""옵션 심리 패널 API (ADR-0135).

**계층 배분이 처음 설계에서 한 번 바뀌었다.** 원안은 "P/C·IV스큐는 ATM 고빈도,
Max Pain·GEX 는 전수 저빈도" 였는데, P/C 비율의 표준 정의가 **전 종목** 거래량·
미결제 비율이라 ATM ±20 창으로 계산하면 이름만 같고 다른 지표가 된다. IV 스마일
곡선도 마찬가지로 양 날개가 있어야 모양이 나온다. 그래서:

    전수 계층(5분)  : P/C 비율, Max Pain, OI 분포, GEX, IV 스마일 곡선 전체
    ATM 계층(30초)  : ATM IV 와 25델타 리스크리버설의 빠른 갱신만

ATM 계층이 덮어쓰는 값은 ``atm_as_of_ms`` 로 시각이 따로 표시되므로, 화면에서
"5분 전 곡선 + 30초 전 ATM 포인트" 라는 사실이 감춰지지 않는다.
"""
from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter

from hoga.api.models import (
    GammaExposureModel,
    GexPointModel,
    IvPointModel,
    IvSkewModel,
    OiDistributionModel,
    OptionSentimentResponse,
    PutCallRatioModel,
    StrikeOiModel,
)
from hoga.live.kis_runtime import ensure_kis_client_for_account
from hoga.live.option_sentiment import (
    gamma_exposure,
    iv_skew,
    oi_distribution,
    put_call_ratio,
)
from hoga.live.option_sentiment_runtime import get_runtime


def build_router(*, data_dir: Path) -> APIRouter:
    router = APIRouter(prefix="/api/sentiment", tags=["sentiment"])

    @router.get("/option", response_model=OptionSentimentResponse)
    async def get_option_sentiment() -> OptionSentimentResponse:
        runtime = get_runtime(lambda: ensure_kis_client_for_account(0, data_dir))
        await runtime.request()
        st = runtime.state()

        if st.full is None:
            # 아직 첫 전수 수집이 안 끝났다(콜드 스타트 ~60초). 휴면 사유가 없으면
            # 'warming' 으로 구분해 UI 가 "설정 필요" 와 "잠시 기다리세요" 를 다르게
            # 안내할 수 있게 한다.
            return OptionSentimentResponse(
                unavailable=st.unavailable or "warming",
                expiry=st.expiry,
            )

        full = st.full
        pc = put_call_ratio(full)
        dist = oi_distribution(full, full_chain=True)
        gex = gamma_exposure(full, full_chain=True)
        skew = iv_skew(full)

        # ATM 계층이 있으면 ATM IV·RR 만 최신값으로 교체한다. 곡선(points)은
        # 전수 것을 유지 — ATM 창은 양 날개가 없어 스마일이 잘린다.
        atm_iv, rr = skew.atm_iv, skew.risk_reversal_25d
        if st.atm is not None:
            fresh = iv_skew(st.atm)
            if fresh.atm_iv is not None:
                atm_iv = fresh.atm_iv
            if fresh.risk_reversal_25d is not None:
                rr = fresh.risk_reversal_25d

        return OptionSentimentResponse(
            unavailable=None,
            expiry=full.expiry,
            underlying=full.underlying,
            full_as_of_ms=st.full_at_ms,
            atm_as_of_ms=st.atm_at_ms,
            put_call=PutCallRatioModel(
                volume_ratio=pc.volume_ratio,
                oi_ratio=pc.oi_ratio,
                call_volume=pc.call_volume,
                put_volume=pc.put_volume,
                call_oi=pc.call_oi,
                put_oi=pc.put_oi,
            ),
            oi_distribution=OiDistributionModel(
                strikes=[
                    StrikeOiModel(strike=s.strike, call_oi=s.call_oi, put_oi=s.put_oi)
                    for s in dist.strikes
                ],
                max_pain=dist.max_pain,
            ),
            gamma_exposure=GammaExposureModel(
                points=[GexPointModel(strike=p.strike, gex=p.gex) for p in gex.points],
                total=gex.total,
                flip_strike=gex.flip_strike,
            ),
            iv_skew=IvSkewModel(
                points=[
                    IvPointModel(strike=p.strike, call_iv=p.call_iv, put_iv=p.put_iv)
                    for p in skew.points
                ],
                atm_iv=atm_iv,
                risk_reversal_25d=rr,
            ),
        )

    return router
