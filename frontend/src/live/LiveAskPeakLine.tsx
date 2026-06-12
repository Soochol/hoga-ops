import { memo, useEffect, useRef } from 'react';
import type { IPriceLine, PriceLineOptions } from 'lightweight-charts';
import type { AskPeak } from '../api/types';
import type { PaneId } from '../chart/drawing/types';
import type { PaneSeriesMap } from '../chart/drawing/chartCoordinates';
import { useLivePageStore } from '../state/livePage';
import { formatQtyKo } from '../util/formatQtyKo';

type Props = {
  paneSeries: PaneSeriesMap;
  /** LivePage의 useDayAskPeak 결과(당일 매도 최대벽). null이면 숨김. */
  peak: AskPeak | null;
};

/** 당일 매도 최대벽 수평선. candle primary series에 native price line 1개를 걸어
 *  (1) 최대벽 가격 수평 실선 + (2) y축 가격 태그 + (3) 물량 라벨(title)을 그린다.
 *  색·두께·on/off는 livePage 스토어, 값(peak)은 prop. 형제: LiveCurrentPriceLine. */
function LiveAskPeakLine({ paneSeries, peak }: Props) {
  const series = paneSeries.get('candle' as PaneId);
  const enabled = useLivePageStore((s) => s.askPeakEnabled);
  const color = useLivePageStore((s) => s.askPeakColor);
  const lineWidth = useLivePageStore((s) => s.askPeakLineWidth);
  const visible = enabled && peak != null;
  const lineRef = useRef<IPriceLine | null>(null);

  useEffect(() => {
    if (!series) return;
    const line = series.createPriceLine({
      price: peak?.price ?? 0,
      color,
      lineWidth,
      lineStyle: 0, // Solid (현재가선 dashed와 구분)
      lineVisible: visible,
      axisLabelVisible: visible,
      axisLabelColor: color,
      title: peak ? `${formatQtyKo(peak.qty)}` : '',
    } as PriceLineOptions);
    lineRef.current = line;
    return () => {
      try { series.removePriceLine(line); } catch { /* torn down */ }
      lineRef.current = null;
    };
    // 생성은 series 핸들당 1회(LiveCurrentPriceLine과 동일). 값 변화는 아래 update effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series]);

  useEffect(() => {
    lineRef.current?.applyOptions({
      price: peak?.price ?? 0,
      color,
      lineWidth,
      lineVisible: visible,
      axisLabelVisible: visible,
      axisLabelColor: color,
      title: peak ? `${formatQtyKo(peak.qty)}` : '',
    } as Partial<PriceLineOptions>);
  }, [peak, color, lineWidth, visible]);

  return null;
}

export default memo(LiveAskPeakLine);
