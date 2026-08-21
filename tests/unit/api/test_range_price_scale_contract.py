"""`RangeBundle` 가격 필드 ↔ 프론트 환산 유틸 드리프트 가드.

## 이 가드가 막는 방향

`/api/range` 지표는 디스크 캡처라 **원주가**이고 `/api/live/past-candles` 의 봉은
**수정주가**다(#1229). 프론트는 둘을 같은 price scale 에 그리므로 지표를 봉 쪽 척도로
옮긴다(`frontend/src/live/scaleRangeBundlePrices.ts`). 그 환산이 **가격 필드를 하나라도
빠뜨리면** 그 지표만 옛 척도로 남고, 증상은 계수 ≠ 1 인 종목·구간에서만 나타난다 —
캡처된 351 종목 중 7개, 그것도 특정 날짜 이전 구간뿐이었다(2026-08-12 실측). 즉
**대부분의 화면에서 무증상**이라 눈으로도 일반 테스트로도 안 걸린다.

그래서 새 가격 필드가 모델에 생기면 여기서 **먼저** 빨개진다.

## 왜 자동 분류가 아닌가

이름 규칙(`*price*`)으로 자동 판별하면 오탐과 누락이 **둘 다 조용하다**. 실제로 이
번들의 가격 필드 중 셋은 이름에 `price` 가 없다 — `depth_heatmap`/`depth_delta` 의
`[price, qty]` **위치 가격**과 `ask_tick`/`bid_tick`(호가 단위). 반대로 `price_step`
류의 이름이 붙었지만 스케일 대상이 아닌 값도 생길 수 있다. 그래서 전 필드를 **손으로**
두 목록에 나눠 담고, 어느 쪽에도 없는 새 필드가 나타나면 실패시킨다.

## 못 보는 것

- 프론트가 목록의 필드를 **실제로 곱하는지**는 여기서 못 잰다(그건
  `scaleRangeBundlePrices.test.ts` 가 값으로 잰다). 이 가드는 "빠진 필드가 없는가" 만
  본다.
- `RangeBundle` 을 **따로 fetch 하는** 소비자가 환산을 지나는지도 못 본다 — 아래
  `test_range_bundle_consumers_are_registered` 가 그 축을 따로 고정한다.
"""
from __future__ import annotations

from pathlib import Path
from typing import get_args, get_origin, get_type_hints

from pydantic import BaseModel

from hoga.api.models import OrderbookResponse, RangeBundle

_FRONTEND = Path(__file__).resolve().parents[3] / "frontend" / "src"
_SCALER = _FRONTEND / "live" / "scaleRangeBundlePrices.ts"

#: 척도(수정계수)를 곱해야 하는 필드. `모델명.필드명` 으로 적는다.
#: 새 가격 필드를 추가하면 여기 등록 + `scaleRangeBundlePrices.ts` 에 곱셈 추가.
PRICE_FIELDS: frozenset[str] = frozenset({
    # 캔들 OHLC (range 의 캔들은 디스크 캡처 = 원주가)
    "ApiCandle.open", "ApiCandle.high", "ApiCandle.low", "ApiCandle.close",
    # 매물대 격자 — 경계와 **폭**이 함께 움직여야 격자가 축과 맞는다
    "VolumeProfile.price_min", "VolumeProfile.price_max", "VolumeProfile.bin_width",
    "VolumeProfileBin.price_low",
    "DayVolumeDistribution.price_min", "DayVolumeDistribution.price_max",
    "VolumeDistributionBin.price_low", "VolumeDistributionBin.price_high",
    # 최대벽 — 가격 변형이 네 갈래다(체결/전체 × 스냅샷/일중최대; ADR-0156 이 미체결 계열 제거)
    "AskPeak.price", "AskPeak.max_price", "AskPeak.all_price", "AskPeak.all_max_price",
    "BidPeak.price", "BidPeak.max_price", "BidPeak.all_price", "BidPeak.all_max_price",
    "AskPeakCandidate.price",
    # VI·상하한 히트
    "PriceLevelHit.price",
    # 거래량 POC
    "TradeVolumePoc.center_price", "TradeVolumePoc.low_price", "TradeVolumePoc.high_price",
    # 호가 잔량 히트맵·증감 — **이름 없는 위치 가격**([price, qty] 튜플의 첫 원소).
    # `price` 로 grep 해도 안 걸리는 자리라 여기 명시적으로 적는다.
    "DepthHeatmapPoint.asks", "DepthHeatmapPoint.bids",
    "DepthHeatmapPoint.asks_max", "DepthHeatmapPoint.bids_max",
    "DepthDeltaPoint.asks", "DepthDeltaPoint.bids",
    # 호가 단위 — 이름에 `price` 가 없지만 **가격공간 값**이다(셀 높이).
    "DepthDeltaPoint.ask_tick", "DepthDeltaPoint.bid_tick",
    # 커서 스팟 10호가 — 히트맵과 **같은 순간 같은 레벨**을 다른 창에 숫자로 띄우므로
    # 척도가 갈리면 사용자가 두 숫자를 동시에 본다.
    "ApiOrderbookLevel.price",
    # 호가벽 급증 — 마커가 **캔들과 같은 가격축에 앉는다**. 환산이 빠지면 마커만
    # 원주가 높이에 찍혀 캔들과 어긋난다(#1303 과 같은 종류의 사고).
    "WallSurgeEvent.price",
})

#: 척도와 무관한 필드(수량·시각·식별자·사유). 새 필드가 여기 있으면 환산 불필요라는
#: **판단을 남긴 것**이다 — 자동 분류가 아니라 사람이 한 번 본 흔적이 남는다.
NON_PRICE_FIELDS: frozenset[str] = frozenset({
    "RangeBundle.code", "RangeBundle.from_date", "RangeBundle.to_date",
    "RangeBundle.bucket_ms", "RangeBundle.segments", "RangeBundle.candles",
    "RangeBundle.quote_ratio", "RangeBundle.fill_strength",
    "RangeBundle.volume_profile_range", "RangeBundle.volume_profile_by_day",
    "RangeBundle.excluded_dates", "RangeBundle.data_warnings", "RangeBundle.missing_dates",
    "RangeBundle.ask_peaks", "RangeBundle.bid_peaks", "RangeBundle.depth_heatmap",
    "RangeBundle.depth_delta", "RangeBundle.broker_late_entries",
    "RangeBundle.price_level_hits", "RangeBundle.trade_volume_pocs",
    "RangeBundle.volume_distributions", "RangeBundle.program_trade",
    "RangeBundle.wall_surge",
    # 호가벽 급증의 나머지 — 잔량·증가량·체결량은 **수량**(주식 수)이고, 총잔량도
    # 같은 이유로 환산 대상이 아니다(QuoteRatioPoint.ask_total 과 같은 판단).
    # kind/outcome/side 는 분류값, t_ms·blind_ms·duration_ms 는 시간이다.
    "WallSurgeEvent.t_ms", "WallSurgeEvent.side", "WallSurgeEvent.qty",
    "WallSurgeEvent.jump", "WallSurgeEvent.total", "WallSurgeEvent.kind",
    "WallSurgeEvent.blind_ms", "WallSurgeEvent.outcome",
    "WallSurgeEvent.filled_qty", "WallSurgeEvent.duration_ms",
    "RangeSegment.date", "RangeSegment.session_open_ms", "RangeSegment.session_close_ms",
    "RangeSegment.source", "RangeSegment.gap_ms",
    "ApiCandle.ts_ms", "ApiCandle.vol_a", "ApiCandle.vol_b",
    "QuoteRatio.bucket_ms", "QuoteRatio.points",
    "QuoteRatioPoint.t", "QuoteRatioPoint.bid_max", "QuoteRatioPoint.ask_max",
    # band_pct 는 **무차원**이다 — (ask_p10 − bid_p10) / mid 라 분자·분모가 같은 단위라서
    # 수정주가 계수를 곱해도 값이 변하지 않는다. 즉 가격 환산 대상이 아닐 뿐 아니라
    # **환산하면 틀린다**(계수가 한 번 더 곱해진다). 가격에서 파생됐다고 PRICE_FIELDS
    # 로 옮기지 말 것 — 파생 여부가 아니라 차원이 기준이다.
    "QuoteRatioPoint.band_pct",
    # tick 은 원 단위지만 **비율로만 소비된다**(tick[i] / tick[ref]). 수정주가 계수를
    # 곱하면 비율은 그대로이고 값만 의미를 잃는다 — 게다가 호가단위는 그 시점의
    # **미수정 가격**으로 결정되므로 환산하면 애초에 틀린 밴드를 가리킨다.
    "QuoteRatioPoint.tick",
    # 총잔량·불균형은 **수량**이다(주식 수) — 별도 pane 의 축이라 가격축과 무관하고,
    # #1229 실측대로 분봉은 수정 여부와 무관하게 수량이 같다.
    "QuoteRatioPoint.ask_total", "QuoteRatioPoint.bid_total",
    "QuoteRatioPoint.imb_max_ask", "QuoteRatioPoint.imb_max_bid",
    "FillStrength.bucket_ms", "FillStrength.points",
    "FillStrengthPoint.t",
    "FillStrengthPoint.buy_qty", "FillStrengthPoint.sell_qty",
    "VolumeProfile.bin_count", "VolumeProfile.bins",
    "VolumeProfileBin.qty",
    "DayVolumeDistribution.date", "DayVolumeDistribution.range_count",
    "DayVolumeDistribution.session_open_ms", "DayVolumeDistribution.session_close_ms",
    "DayVolumeDistribution.last_trade_ms", "DayVolumeDistribution.bins",
    "VolumeDistributionBin.qty",
    "ExcludedDate.date", "ExcludedDate.violations",
    "DateWarning.date", "DateWarning.warnings",
    "MissingDate.date", "MissingDate.reason",
    "ViolationModel.invariant_id", "ViolationModel.severity", "ViolationModel.message",
    "ViolationModel.ctx",
    "AskPeak.date", "AskPeak.qty", "AskPeak.t_ms", "AskPeak.max_qty", "AskPeak.max_t_ms",
    "AskPeak.all_qty", "AskPeak.all_t_ms", "AskPeak.all_max_qty", "AskPeak.all_max_t_ms",
    "AskPeak.traded_peaks", "AskPeak.traded_max_peaks",
    "AskPeak.all_peaks", "AskPeak.all_max_peaks",
    "BidPeak.date", "BidPeak.qty", "BidPeak.t_ms", "BidPeak.max_qty", "BidPeak.max_t_ms",
    "BidPeak.all_qty", "BidPeak.all_t_ms", "BidPeak.all_max_qty", "BidPeak.all_max_t_ms",
    "BidPeak.traded_peaks", "BidPeak.traded_max_peaks",
    "BidPeak.all_peaks", "BidPeak.all_max_peaks",
    "AskPeakCandidate.qty", "AskPeakCandidate.t_ms",
    "PriceLevelHit.date", "PriceLevelHit.t_ms", "PriceLevelHit.kind",
    "PriceLevelHit.direction", "PriceLevelHit.pct",
    "TradeVolumePoc.date", "TradeVolumePoc.qty", "TradeVolumePoc.t_ms",
    "TradeVolumePoc.band_pct",
    "DepthHeatmapPoint.t_ms",
    "DepthDeltaPoint.t_ms",
    "BrokerLateEntryEvent.t_ms", "BrokerLateEntryEvent.broker",
    "BrokerLateEntryEvent.side", "BrokerLateEntryEvent.net",
    "ProgramTradeSeries.points",
    "ProgramTradeSeries.source",
    # 프로그램 순매수는 **금액·수량**이지 가격이 아니다 — 자체 pane 에 그려지고
    # 가격축을 공유하지 않으므로 척도와 무관하다.
    "ProgramTradePoint.t",
    "ProgramTradePoint.net_qty", "ProgramTradePoint.net_amount",
    "ProgramTradePoint.delta_qty", "ProgramTradePoint.delta_amount",
    "ProgramTradePoint.gap_risk",
    # 커서 스팟 호가창 — 총잔량은 **수량**이다.
    "OrderbookResponse.available_from", "OrderbookResponse.snapshot",
    "OrderbookResponse.source",
    "ApiOrderbookSnapshot.ts_ms", "ApiOrderbookSnapshot.seq",
    "ApiOrderbookSnapshot.ask", "ApiOrderbookSnapshot.bid",
    "ApiOrderbookSnapshot.tot_ask", "ApiOrderbookSnapshot.tot_bid",
    "ApiOrderbookLevel.qty",
})


def _walk_models(model: type[BaseModel], seen: set[type[BaseModel]]) -> set[str]:
    """`모델명.필드명` 전수. 중첩 모델을 재귀로 따라간다.

    **`get_type_hints` 로 해석해야 한다.** 이 모듈은 `from __future__ import
    annotations` 를 쓰고 일부 모델은 참조보다 아래에 정의돼 있어, `field.annotation`
    이 미해결 `ForwardRef` 로 남는다(`RangeBundle.broker_late_entries` 가 실제로
    그랬다). 그러면 순회가 그 하위 모델을 **조용히 건너뛰고**, 가드는 초록인데
    가격 필드가 미분류로 새 나간다 — 이 가드가 막으려는 실패 유형 그 자체다.
    """
    if model in seen:
        return set()
    seen.add(model)
    hints = get_type_hints(model)
    out: set[str] = set()
    for name in model.model_fields:
        out.add(f"{model.__name__}.{name}")
        out |= _nested(hints.get(name), seen)
    return out


def _nested(annotation: object, seen: set[type[BaseModel]]) -> set[str]:
    if isinstance(annotation, type) and issubclass(annotation, BaseModel):
        return _walk_models(annotation, seen)
    out: set[str] = set()
    if get_origin(annotation) is not None:
        for arg in get_args(annotation):
            out |= _nested(arg, seen)
    return out


def _strip_comments(source: str) -> str:
    """`//` 줄 주석과 `/* */` 블록 주석을 지운 소스. 문자열 리터럴은 고려하지 않는다 —
    이 파일에 가격 필드 이름을 담은 문자열 리터럴이 없기 때문이고, 생기면 이 단순화가
    깨지므로 그때는 파서를 쓸 것."""
    out: list[str] = []
    depth = 0
    for raw in source.splitlines():
        line = raw
        if "/*" in line and "*/" not in line:
            depth += 1
            line = line.split("/*", 1)[0]
        elif "*/" in line and "/*" not in line:
            depth -= 1
            line = line.split("*/", 1)[1]
        elif depth > 0:
            continue
        out.append(line.split("//", 1)[0])
    return "\n".join(out)

#: 가격을 싣고 **차트와 같은 화면에 숫자로 뜨는** wire model 루트.
#: `/api/orderbook` 이 여기 있는 이유: 커서 스팟 10호가는 히트맵과 같은 순간 같은 레벨을
#: 옆 창에 띄우므로, 척도가 갈리면 사용자가 두 숫자를 나란히 본다.
_ROOTS = (RangeBundle, OrderbookResponse)


def _walk_all_roots() -> set[str]:
    seen: set[type[BaseModel]] = set()
    out: set[str] = set()
    for root in _ROOTS:
        out |= _walk_models(root, seen)
    return out


def test_every_range_bundle_field_is_classified() -> None:
    """새 필드는 **가격이냐 아니냐**를 사람이 정하기 전엔 통과하지 못한다.

    막는 방향: 가격 필드가 조용히 늘어나 프론트 환산이 그것만 빠뜨리는 것. 그 증상은
    계수 ≠ 1 인 소수 종목·구간에서만 나오므로 일반 테스트·눈으로는 안 걸린다.
    """
    actual = _walk_all_roots()
    classified = PRICE_FIELDS | NON_PRICE_FIELDS

    unclassified = actual - classified
    assert not unclassified, (
        f"RangeBundle 에 분류되지 않은 필드가 있다: {sorted(unclassified)}\n"
        "가격이면 PRICE_FIELDS 에 넣고 frontend/src/live/scaleRangeBundlePrices.ts 에 "
        "곱셈을 추가할 것. 아니면 NON_PRICE_FIELDS 에 넣을 것 — 어느 쪽이든 "
        "**판단을 남겨야** 다음 사람이 다시 조사하지 않는다."
    )

    stale = classified - actual
    assert not stale, (
        f"모델에 없는 필드가 목록에 남아 있다: {sorted(stale)} — 지운 필드의 잔해라면 "
        "목록에서도 지울 것(죽은 항목은 목록의 신뢰를 갉는다)."
    )


def test_price_fields_appear_in_the_frontend_scaler() -> None:
    """등록된 가격 필드는 프론트 환산 유틸 소스에 **이름이 등장해야** 한다.

    못 보는 것: 등장한다고 실제로 곱한다는 뜻은 아니다(값 검증은
    `scaleRangeBundlePrices.test.ts`). 이 층은 **누락**만 본다 — 새 가격 필드를 모델에
    추가하고 프론트를 안 건드린 PR 을 잡는 것이 목적이다.
    """
    # **주석을 지우고 본다.** 이 파일은 필드 이름을 설명 주석에도 적으므로(예:
    # "bin_width 도 가격공간 값이다"), 원문 그대로 찾으면 곱셈을 지워도 주석이 남아
    # 가드가 초록으로 통과한다 — 실제로 red-check 에서 그렇게 새는 것을 확인했다.
    source = _strip_comments(_SCALER.read_text(encoding="utf-8"))
    missing = sorted(
        field for field in PRICE_FIELDS
        if field.split(".", 1)[1] not in source
    )
    assert not missing, (
        f"가격 필드가 프론트 환산 유틸에 안 보인다: {missing}\n"
        f"{_SCALER} 에 곱셈을 추가할 것 — 빠지면 그 지표만 원주가로 남아 "
        "계수 ≠ 1 인 구간에서 어긋난다."
    )


#: `RangeBundle` 을 **자체 fetch** 하는 프론트 소비자. 각 항목은 (파일, 사유).
#: 환산은 `useLiveBundle` 한 곳에서 하는 것이 원칙이라, 따로 fetch 하는 자리는 저마다
#: 환산을 지나야 하고 그 사실을 여기 남긴다.
RANGE_BUNDLE_CONSUMERS: dict[str, str] = {
    "live/useLiveBundle.ts": "주 경로 — 여기서 환산한다(scaledHogaData/scaledSidecarData)",
    "live/useVolumeDistributionCutoffProfile.ts":
        "매물대 호버 컷오프 — 자체 useRange. 요청은 역환산, 응답은 환산한다",
}


def test_range_bundle_consumers_are_registered() -> None:
    """`useRange` 계열을 부르는 파일이 늘면 **환산 여부를 판단하게** 만든다.

    막는 방향: 새 소비자가 `/api/range` 를 자체 fetch 하면서 환산을 안 지나 그 화면만
    원주가로 남는 것 — 이번에 실제로 그렇게 새던 자리가
    `useVolumeDistributionCutoffProfile` 이었다(주 경로만 배선하면 못 본다).
    """
    hits: set[str] = set()
    for path in _FRONTEND.rglob("*.ts*"):
        if ".test." in path.name or path.name.endswith(".d.ts"):
            continue
        if path.name in {"range.ts", "rangeRequest.ts"}:
            continue  # 훅 정의부 자신
        text = path.read_text(encoding="utf-8")
        if any(f"{fn}(" in text for fn in
               ("useRange", "useRangeHogaDelta", "useRangeSidecarDelta")):
            hits.add(str(path.relative_to(_FRONTEND)))

    unregistered = hits - set(RANGE_BUNDLE_CONSUMERS)
    assert not unregistered, (
        f"RangeBundle 을 자체 fetch 하는 미등록 소비자: {sorted(unregistered)}\n"
        "그 자리가 수정계수 환산을 지나는지 판단하고 RANGE_BUNDLE_CONSUMERS 에 사유와 "
        "함께 등록할 것. 안 지나면 그 화면만 원주가로 남는다."
    )
    stale = set(RANGE_BUNDLE_CONSUMERS) - hits
    assert not stale, f"더 이상 range 를 안 부르는 등록 항목: {sorted(stale)}"
