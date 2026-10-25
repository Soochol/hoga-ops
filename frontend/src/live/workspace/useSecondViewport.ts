import { useEffect, useLayoutEffect, useRef } from 'react';
import type { IChartApi } from 'lightweight-charts';
import type { Candle } from '../../api/types';
import { captureSecondViewport, restoreSecondViewport, type SecondChartViewport } from './secondChartViewport';

/** Snapshot before series effects replace their time grid. Keep the pending
 * anchor through empty loading pages and restore zoom after prepend/filtering. */
export function useSecondViewport(chart: IChartApi | null, candles: readonly Candle[] | undefined) {
  const previous = useRef<{ chart: IChartApi; bars: { t_ms: number }[] } | null>(null);
  const pending = useRef<SecondChartViewport | null>(null);
  useLayoutEffect(() => {
    if (!chart || !candles) { previous.current = null; pending.current = null; return; }
    const old = previous.current;
    if (old?.chart !== chart) { previous.current = null; pending.current = null; }
    const bars = candles.map(c => ({ t_ms: c.ts_ms }));
    if (old?.chart === chart && old.bars.length && old.bars[0].t_ms !== bars[0]?.t_ms && !pending.current) {
      const scale = chart.timeScale();
      pending.current = captureSecondViewport(old.bars, scale.getVisibleLogicalRange(), scale.options().barSpacing);
    }
    if (bars.length) previous.current = { chart, bars };
  }, [chart, candles]);
  useEffect(() => {
    if (!chart || !candles?.length || !pending.current || !previous.current) return;
    const scale = chart.timeScale();
    scale.setVisibleLogicalRange(restoreSecondViewport(previous.current.bars, pending.current));
    scale.applyOptions({ barSpacing: pending.current.barSpacing });
    pending.current = null;
  }, [chart, candles]);
}
