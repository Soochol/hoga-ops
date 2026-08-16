import { memo } from 'react';
import type { RangeBundle } from '../api/types';
import type { PaneId } from '../chart/drawing/types';
import type { PaneSeriesMap } from '../chart/drawing/chartCoordinates';
import type { VirtualAxis } from '../util/virtualAxis';
import { useActivePrefs } from '../state/chartPrefs';
import SeriesLevelLine from './SeriesLevelLine';
import { deriveQuoteTotalsDayMax, deriveQuoteTotalsLevels, deriveRatioLevel } from './deriveQuoteLevelLines';
import { useWindowIndicator } from './workspace/windowView';

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
 *  - 총잔량 당일 최고: 오늘 최고였던 높이에 2개. 현재값과 독립 토글이라 둘 다 켤 수 있고,
 *    신고가를 갱신하는 순간에만 포개진다(그래서 title로 구분한다).
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
  // 당일 최고는 "지금이 오늘인가"에 의존한다 — Date.now()는 여기(호출부)에서만 읽고 파생
  // 함수엔 값으로 넘긴다(그래야 파생 테스트가 시계에 묶이지 않는다). 틱마다 재평가되므로
  // 자정을 넘겨 열어둔 차트는 다음 틱에 스스로 교정된다.
  const dayMax = dayMaxEnabled
    ? deriveQuoteTotalsDayMax(bundle, qtIntraMax, (t) => axis.inClosingAuctionWindow(t), Date.now())
    : null;

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
        enabled={dayMaxEnabled}
        title="최고"
      />
      <SeriesLevelLine
        series={quoteTotalsSeries}
        price={dayMax?.ask ?? null}
        color={dayMaxAskColor}
        lineWidth={dayMaxAskWidth}
        lineStyle={dayMaxAskStyle}
        enabled={dayMaxEnabled}
        title="최고"
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
