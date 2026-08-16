import { memo } from 'react';
import type { RangeBundle } from '../api/types';
import type { PaneId } from '../chart/drawing/types';
import type { PaneSeriesMap } from '../chart/drawing/chartCoordinates';
import type { VirtualAxis } from '../util/virtualAxis';
import { useActivePrefs } from '../state/chartPrefs';
import SeriesLevelLine from './SeriesLevelLine';
import { deriveQuoteTotalsDayMax, deriveQuoteTotalsLevels, deriveRatioLevel } from './deriveQuoteLevelLines';
import { tradingDayOf } from '../util/tradingDay';
import { useWindowIndicator, useWindowIndicatorScope } from './workspace/windowView';

/** epoch ms 의 KST 월/일(예 "8/14"). 낡은 기준선에 붙이는 라벨용이라 연도는 뺀다 —
 *  차트가 보여주는 범위가 며칠 단위라 M/D 로 충분하고, 칩이 짧을수록 라인을 덜 가린다. */
const kstMonthDay = (ms: number): string => {
  const d = new Date(ms + 9 * 60 * 60 * 1000);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
};

type Props = {
  paneSeries: PaneSeriesMap;
  /** hoga bundle (quote_ratio) — LiveChartRoot's paneRatioBundle. Feeds the
   *  current-value derivation; SSE ticks change its identity so the level tracks
   *  live, while SeriesLevelLine's primitive-deps effect avoids handle churn. */
  bundle: RangeBundle;
  /** 당일 최고 수평선이 마감 동시호가를 배제하는 데 쓰는 축(inClosingAuctionWindow).
   *  세션 마감은 venue 별로 달라 시각을 상수로 박을 수 없다 — 축이 유일한 출처다. */
  axis: VirtualAxis;
};

/**
 * 총잔량·호가비 pane의 수평 기준선 묶음. 각 pane primary series에 native price
 * line 을 걸어 현재가 라인(LiveCurrentPriceLine)의 pane 버전을 제공한다.
 *  - 총잔량 현재값: 매수·매도 각각 수평선 2개(같은 pane, 독립 price line).
 *  - 총잔량 최고(**`/live` 전용**): 마지막 거래일 최고 높이에 2개. 현재값과 독립 토글이라
 *    둘 다 켤 수 있고, 신고가를 갱신하는 순간에만 포개진다(그래서 title로 구분한다).
 *  - 호가비: 0선 기준 불균형 수평선 1개.
 * intraMax 는 각 라인 프로젝터와 동일한 chartPref 를 읽어 라인 끝점과 정렬한다.
 * pane 이 mount 되지 않은 timeframe(D/W/M)에선 series 가 undefined → 렌더 없음.
 */
function QuoteLevelLines({ paneSeries, bundle, axis }: Props) {
  const quoteTotalsSeries = paneSeries.get('quote-totals' as PaneId);
  const ratioSeries = paneSeries.get('ratio' as PaneId);

  const qtEnabled = useWindowIndicator((s) => s.quoteTotalsLevelLineEnabled);
  const qtBidColor = useWindowIndicator((s) => s.quoteTotalsBidLevelColor);
  const qtBidWidth = useWindowIndicator((s) => s.quoteTotalsBidLevelWidth);
  const qtBidStyle = useWindowIndicator((s) => s.quoteTotalsBidLevelStyle);
  const qtAskColor = useWindowIndicator((s) => s.quoteTotalsAskLevelColor);
  const qtAskWidth = useWindowIndicator((s) => s.quoteTotalsAskLevelWidth);
  const qtAskStyle = useWindowIndicator((s) => s.quoteTotalsAskLevelStyle);

  const dayMaxEnabled = useWindowIndicator((s) => s.quoteTotalsDayMaxLineEnabled);
  const dayMaxBidColor = useWindowIndicator((s) => s.quoteTotalsDayMaxBidColor);
  const dayMaxBidWidth = useWindowIndicator((s) => s.quoteTotalsDayMaxBidWidth);
  const dayMaxBidStyle = useWindowIndicator((s) => s.quoteTotalsDayMaxBidStyle);
  const dayMaxAskColor = useWindowIndicator((s) => s.quoteTotalsDayMaxAskColor);
  const dayMaxAskWidth = useWindowIndicator((s) => s.quoteTotalsDayMaxAskWidth);
  const dayMaxAskStyle = useWindowIndicator((s) => s.quoteTotalsDayMaxAskStyle);

  const ratioEnabled = useWindowIndicator((s) => s.ratioLevelLineEnabled);
  const ratioColor = useWindowIndicator((s) => s.ratioLevelColor);
  const ratioWidth = useWindowIndicator((s) => s.ratioLevelWidth);
  const ratioStyle = useWindowIndicator((s) => s.ratioLevelStyle);

  const qtIntraMax = useActivePrefs((p) => p.quoteTotalsIntraMax);
  const ratioIntraMax = useActivePrefs((p) => p.ratioIntraMax);

  const levels = deriveQuoteTotalsLevels(bundle, qtIntraMax);
  const ratioValue = deriveRatioLevel(bundle, ratioIntraMax);
  // 최고 수평선은 **`/live` 전용**이다. 기준일이 "데이터의 마지막 거래일" 이라 복기에서는
  // 로드된 구간의 **끝날**이 되는데, 복기는 그 구간 한가운데의 "그때 그 시점" 을 보는
  // 작업이다 — 6/25 를 되짚는 화면에 7/24 기준선이 그어지면 선만 미래를 알고 있어 방해가
  // 된다. 라이브에선 마지막 거래일이 곧 "지금" 이라 이 어긋남이 없다(현재값 수평선은 성격이
  // 달라 — 언제나 "보고 있는 그 시점의 값" — 여기서 막지 않는다).
  // 페이지는 어댑터에서 렌더 동기적으로 온다(ADR-0146). Provider 밖(null)은 `/live` 폴백.
  const dayMaxAllowed = useWindowIndicatorScope() !== 'study';
  const dayMaxOn = dayMaxEnabled && dayMaxAllowed;
  // 기준일은 데이터의 마지막 거래일이라 파생은 시계와 무관하다(장중엔 그게 곧 오늘, 장
  // 마감 후·주말엔 직전 거래일). 시계는 **라벨에만** 쓴다 — 오늘 것이 아니면 날짜를 붙여
  // 낡은 기준선을 오늘 것으로 착각하지 않게 한다.
  const dayMax = dayMaxOn
    ? deriveQuoteTotalsDayMax(bundle, qtIntraMax, (t) => axis.inClosingAuctionWindow(t))
    : null;
  const dayMaxTitle =
    dayMax && tradingDayOf(dayMax.t) !== tradingDayOf(Date.now())
      ? `${kstMonthDay(dayMax.t)} 최고`
      : '최고';

  return (
    <>
      <SeriesLevelLine
        series={quoteTotalsSeries}
        price={levels?.bid ?? null}
        color={qtBidColor}
        lineWidth={qtBidWidth}
        lineStyle={qtBidStyle}
        enabled={qtEnabled}
      />
      <SeriesLevelLine
        series={quoteTotalsSeries}
        price={levels?.ask ?? null}
        color={qtAskColor}
        lineWidth={qtAskWidth}
        lineStyle={qtAskStyle}
        enabled={qtEnabled}
      />
      <SeriesLevelLine
        series={quoteTotalsSeries}
        price={dayMax?.bid ?? null}
        color={dayMaxBidColor}
        lineWidth={dayMaxBidWidth}
        lineStyle={dayMaxBidStyle}
        enabled={dayMaxOn}
        title={dayMaxTitle}
      />
      <SeriesLevelLine
        series={quoteTotalsSeries}
        price={dayMax?.ask ?? null}
        color={dayMaxAskColor}
        lineWidth={dayMaxAskWidth}
        lineStyle={dayMaxAskStyle}
        enabled={dayMaxOn}
        title={dayMaxTitle}
      />
      <SeriesLevelLine
        series={ratioSeries}
        price={ratioValue}
        color={ratioColor}
        lineWidth={ratioWidth}
        lineStyle={ratioStyle}
        enabled={ratioEnabled}
      />
    </>
  );
}

export default memo(QuoteLevelLines);
