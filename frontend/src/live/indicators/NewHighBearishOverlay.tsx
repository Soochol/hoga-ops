import { memo, useEffect, useMemo, useRef } from 'react';
import type { ISeriesApi, SeriesType } from 'lightweight-charts';
import type { RangeBundle } from '../../api/types';
import type { VirtualAxis } from '../../util/virtualAxis';
import type { PaneSeriesMap } from '../../chart/drawing/chartCoordinates';
import type { LiveTimeframe } from '../../state/livePage';
import type { LiveVenueOption } from '../../state/liveVenue';
import { NewHighBearishRaysPrimitive } from '../../chart/NewHighBearishRaysPrimitive';
import { bearishRayEndMs, computeNewHighBearishOpen, domesticDailyCandleClosed } from '../../chart/projectors/newHighBearishOpen';
import { useWindowIndicator, useWindowScopeId } from '../workspace/windowView';
import { useNowMs } from '../../util/useNowMs';
import { registerFlagLegendValues, unregisterFlagLegendValues, type FlagLegendValueProvider } from './flagLegendValueRegistry';

type Props = { bundle: RangeBundle; axis: VirtualAxis; paneSeries: PaneSeriesMap; timeframe: LiveTimeframe; venue: LiveVenueOption; code: string | null };

function NewHighBearishOverlay(props: Props) {
  const enabled = useWindowIndicator(s => s.newHighBearishEnabled);
  if (!enabled || props.timeframe !== 'D' || !props.code || !/^[0-9A-Z]{6}$/.test(props.code)) return null;
  return <ActiveOverlay {...props} />;
}

function ActiveOverlay({ bundle, axis, paneSeries, venue }: Props) {
  const lookback = useWindowIndicator(s => s.newHighBearishLookback);
  const dropPct = useWindowIndicator(s => s.newHighBearishDropPct);
  const months = useWindowIndicator(s => s.newHighBearishMonths);
  const maxCount = useWindowIndicator(s => s.newHighBearishMaxCount);
  const hidden = useWindowIndicator(s => s.newHighBearishHidden);
  const color = useWindowIndicator(s => s.newHighBearishColor);
  const width = useWindowIndicator(s => s.newHighBearishLineWidth);
  const scope = useWindowScopeId();
  const now = useNowMs(60_000);
  const series = paneSeries.get('candle') as ISeriesApi<SeriesType> | undefined;
  const primitive = useRef<NewHighBearishRaysPrimitive | null>(null);
  const signals = useMemo(() => computeNewHighBearishOpen(bundle.candles, lookback, dropPct, maxCount,
    c => domesticDailyCandleClosed(c.ts_ms, now, venue)), [bundle.candles, lookback, dropPct, maxCount, now, venue]);
  const rays = useMemo(() => signals.filter(s => axis.contains(s.ts_ms)).map(s => {
    const end = bearishRayEndMs(s.ts_ms, months);
    let lo = 0, hi = bundle.candles.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (bundle.candles[mid].ts_ms <= end) lo = mid + 1; else hi = mid; }
    return { time: axis.toVirtual(s.ts_ms) / 1000, endTime: axis.toVirtual(bundle.candles[Math.max(0, lo - 1)].ts_ms) / 1000, price: s.price,
      ...(end > bundle.candles.at(-1)!.ts_ms ? { futureEndMs: end } : {}) };
  }), [signals, axis, months, bundle.candles]);
  useEffect(() => {
    if (!series) return;
    const next = new NewHighBearishRaysPrimitive();
    series.attachPrimitive(next); primitive.current = next;
    return () => { primitive.current = null; try { series.detachPrimitive(next); } catch { /* chart removed */ } };
  }, [series]);
  useEffect(() => { primitive.current?.setData(hidden ? [] : rays, color, width, { axis, lastRealMs: bundle.candles.at(-1)?.ts_ms ?? 0 }); }, [series, rays, hidden, color, width, axis, bundle.candles]);
  useEffect(() => {
    const provider: FlagLegendValueProvider = time => {
      const realTime = time === null ? bundle.candles.at(-1)?.ts_ms : axis.toReal(time * 1000);
      const before = signals.filter(s => realTime !== undefined && s.ts_ms <= realTime && realTime <= bearishRayEndMs(s.ts_ms, months));
      return before.slice(-maxCount).map(s => ({ key: String(s.ts_ms), label: `${s.ordinal}번째 시가`, color,
        value: s.price.toLocaleString('ko-KR', { maximumFractionDigits: 2 }) }));
    };
    registerFlagLegendValues(scope, 'new-high-bearish', 'main', provider);
    return () => unregisterFlagLegendValues(scope, 'new-high-bearish', 'main', provider);
  }, [scope, signals, axis, color, maxCount, months, bundle.candles]);
  return null;
}
export default memo(NewHighBearishOverlay);
