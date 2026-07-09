import { memo } from 'react';
import type { RangeBundle } from '../api/types';
import type { PaneId } from '../chart/drawing/types';
import type { PaneSeriesMap } from '../chart/drawing/chartCoordinates';
import { useLivePageStore } from '../state/livePage';
import { useActivePrefs } from '../state/chartPrefs';
import SeriesLevelLine from './SeriesLevelLine';
import { deriveQuoteTotalsLevels, deriveRatioLevel } from './deriveQuoteLevelLines';

type Props = {
  paneSeries: PaneSeriesMap;
  /** hoga bundle (quote_ratio) — LiveChartRoot's paneRatioBundle. Feeds the
   *  current-value derivation; SSE ticks change its identity so the level tracks
   *  live, while SeriesLevelLine's primitive-deps effect avoids handle churn. */
  bundle: RangeBundle;
};

/**
 * 총잔량·호가비 pane의 현재값 수평선 묶음. 각 pane primary series에 native price
 * line 을 걸어 현재가 라인(LiveCurrentPriceLine)의 pane 버전을 제공한다.
 *  - 총잔량: 매수·매도 각각 수평선 2개(같은 pane, 독립 price line).
 *  - 호가비: 0선 기준 불균형 수평선 1개.
 * intraMax 는 각 라인 프로젝터와 동일한 chartPref 를 읽어 라인 끝점과 정렬한다.
 * pane 이 mount 되지 않은 timeframe(D/W/M)에선 series 가 undefined → 렌더 없음.
 */
function QuoteLevelLines({ paneSeries, bundle }: Props) {
  const quoteTotalsSeries = paneSeries.get('quote-totals' as PaneId);
  const ratioSeries = paneSeries.get('ratio' as PaneId);

  const qtEnabled = useLivePageStore((s) => s.quoteTotalsLevelLineEnabled);
  const qtBidColor = useLivePageStore((s) => s.quoteTotalsBidLevelColor);
  const qtBidWidth = useLivePageStore((s) => s.quoteTotalsBidLevelWidth);
  const qtBidStyle = useLivePageStore((s) => s.quoteTotalsBidLevelStyle);
  const qtAskColor = useLivePageStore((s) => s.quoteTotalsAskLevelColor);
  const qtAskWidth = useLivePageStore((s) => s.quoteTotalsAskLevelWidth);
  const qtAskStyle = useLivePageStore((s) => s.quoteTotalsAskLevelStyle);

  const ratioEnabled = useLivePageStore((s) => s.ratioLevelLineEnabled);
  const ratioColor = useLivePageStore((s) => s.ratioLevelColor);
  const ratioWidth = useLivePageStore((s) => s.ratioLevelWidth);
  const ratioStyle = useLivePageStore((s) => s.ratioLevelStyle);

  const qtIntraMax = useActivePrefs((p) => p.quoteTotalsIntraMax);
  const ratioIntraMax = useActivePrefs((p) => p.ratioIntraMax);

  const levels = deriveQuoteTotalsLevels(bundle, qtIntraMax);
  const ratioValue = deriveRatioLevel(bundle, ratioIntraMax);

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
