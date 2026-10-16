import { useEffect, useMemo, useState } from 'react';
import type { MouseEventParams, Time } from 'lightweight-charts';
import { VolumeDistributionCard } from '../../sidebar/VolumeDistributionCard';
import { useWindowIndicators, useWindowView } from '../workspace/windowView';
import { useLiveDistributionTrades } from '../useLiveVolumeDistribution';
import { useVolumeDistributionCutoffProfile } from '../useVolumeDistributionCutoffProfile';
import { regularSessionBinningSegment } from '../continuousTradeVolumeDistribution';
import { safeUnsubscribe } from '../../chart/util/safeUnsubscribe';
import { isMinuteTimeframe } from '../../state/livePage';
import { regularSessionOpenMs, regularSessionCloseMs } from '../liveDateTime';
import type { Timeframe } from '../../api/types';
import type { InstanceOverlayProps } from './IndicatorInstanceOverlays';
import { IndicatorInstanceLegend } from './IndicatorInstanceLegend';

/** Distribution cards have their own vertical region instead of overlapping each other. */
export function IndicatorDistributionInstance(props: InstanceOverlayProps & { id?: string }) {
  const settings = useWindowIndicators();
  const view = useWindowView();
  const regularOnly = isMinuteTimeframe(props.timeframe) && view.regularSessionOnly === true;
  const [cursorMs, setCursorMs] = useState<number | null>(null);
  useEffect(() => {
    let frame: number | null = null;
    const handler = (event: MouseEventParams<Time>) => {
      if (frame !== null) cancelAnimationFrame(frame);
      const ms = typeof event.time === 'number' ? props.axis.toReal(event.time * 1000) : null;
      frame = requestAnimationFrame(() => { frame = null; setCursorMs(ms); });
    };
    props.chart.subscribeCrosshairMove(handler);
    return () => { if (frame !== null) cancelAnimationFrame(frame); safeUnsubscribe(() => props.chart.unsubscribeCrosshairMove(handler)); };
  }, [props.chart, props.axis]);
  const segment = useMemo(() => {
    const source = props.bundle.segments.find(s => cursorMs != null && cursorMs >= s.session_open_ms && cursorMs < s.session_close_ms)
      ?? props.bundle.segments.at(-1);
    if (!source) return null;
    const selected = regularSessionBinningSegment(source, props.venue);
    return { ...selected, venue: props.venue, ...(regularOnly ? {
      session_open_ms: Math.max(selected.session_open_ms, regularSessionOpenMs(selected.date)),
      session_close_ms: Math.min(selected.session_close_ms, regularSessionCloseMs(selected.date)),
    } : {}) };
  }, [props.bundle.segments, cursorMs, props.venue, regularOnly]);
  const live = useLiveDistributionTrades(props.liveTradeSnapshots, segment?.date === props.todayKst);
  const candles = useMemo(() => segment ? props.bundle.candles.filter(c => c.ts_ms >= segment.session_open_ms && c.ts_ms < segment.session_close_ms) : [], [segment, props.bundle.candles]);
  const profile = useVolumeDistributionCutoffProfile({
    regularSessionOnly: regularOnly,
    enabled: true, code: props.code, date: segment?.date ?? null, timeframe: props.timeframe as Timeframe, todayKst: props.todayKst,
    cursorMs: settings.volumeDistributionHoverCutoffEnabled ? cursorMs : segment?.session_close_ms ?? null,
    exactCutoffMs: settings.volumeDistributionHoverCutoffEnabled ? undefined : segment?.session_close_ms,
    rangeCount: settings.volumeDistributionRangeCount, priceRange: null,
    finalProfile: undefined, adjustFactors: props.adjustFactors,
    liveTrades: live.trades, candles, segment,
  });
  return <section className="indicator-distribution-instance" aria-label={`연속체결 매물대 분포 ${settings.volumeDistributionRangeCount}구간`}>
    {props.id ? <IndicatorInstanceLegend id={props.id} /> : <div className="text-sm text-fg">연속체결 매물대 분포 · {settings.volumeDistributionRangeCount}구간</div>}
    <VolumeDistributionCard profile={profile} cursorMs={cursorMs} color={settings.volumeDistributionColor} maxColor={settings.volumeDistributionMaxColor} />
  </section>;
}
