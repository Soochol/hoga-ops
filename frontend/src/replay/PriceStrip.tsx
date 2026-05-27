import { useEffect, useMemo } from 'react';
import { useTabsStore } from '../state/tabs';
import { useViewportStore } from '../state/viewport';
import { SourceChip } from '../chart/SourceChip';

/**
 * PriceStrip — viewport-tracked price + delta% header for the active tab.
 *
 * Task 6.5: subscribes (via `useViewportStore`, written by ChartStage) to the
 * chart's visible time range. Resolves right-edge and left-edge candle closes
 * from the bundle, renders the right-edge close as the "current price", and
 * the percent change between left and right edges as the delta. Also
 * synchronizes the active tab's `cursorMs` to the viewport's right edge so
 * orderbook / time-series resolvers downstream agree on "now".
 */
export default function PriceStrip() {
  const active = useTabsStore((s) => s.tabs.find((t) => t.id === s.activeTabId)!);
  const fromMs = useViewportStore((s) => s.fromMs);
  const toMs = useViewportStore((s) => s.toMs);

  // Flatten candles across all loaded bundles for the active tab. Bundles
  // map date -> RangeBundle; for multi-day selections we want to walk
  // them in chronological order so the viewport->close lookup walks a
  // single sorted ts_ms array.
  const allCandles = useMemo(() => {
    if (active.status !== 'loaded') return [];
    const dates = [...active.bundles.keys()].sort();
    return dates.flatMap((d) => active.bundles.get(d)?.candles ?? []);
  }, [active.status, active.bundles]);

  // Resolve the last segment's source from the chronologically latest bundle
  // (ADR-0039). This is what SourceChip surfaces in the strip.
  const lastSegmentSource = useMemo(() => {
    if (active.status !== 'loaded') return undefined;
    const dates = [...active.bundles.keys()].sort();
    const lastDate = dates.at(-1);
    if (!lastDate) return undefined;
    return active.bundles.get(lastDate)?.segments.at(-1)?.source;
  }, [active.status, active.bundles]);

  // Update tabs.cursorMs based on right edge (Task 6.5 contract). Wrapped
  // in useEffect to avoid setState-during-render. Hook order is preserved
  // by calling this before any early returns.
  useEffect(() => {
    if (active.status !== 'loaded') return;
    useTabsStore.getState().setCursor(active.id, toMs);
  }, [active.id, active.status, toMs]);

  if (active.status !== 'loaded') {
    return <div className="h-pricestrip bg-bg-subtle border-b" />;
  }

  // Resolve the latest candle close at-or-before `atMs`. allCandles is
  // sorted ASC by ts_ms, so we can early-break. Linear scan is fine: a
  // session's candle count is on the order of a few hundred at most.
  const findClose = (atMs: number | null): number | null => {
    if (atMs == null || allCandles.length === 0) return null;
    let best: number | null = null;
    for (const c of allCandles) {
      if (c.ts_ms <= atMs) best = c.close;
      else break;
    }
    return best;
  };

  const rightClose =
    findClose(toMs) ?? allCandles[allCandles.length - 1]?.close ?? null;
  const leftClose = findClose(fromMs) ?? allCandles[0]?.close ?? null;
  const delta =
    rightClose != null && leftClose != null && leftClose !== 0
      ? ((rightClose - leftClose) / leftClose) * 100
      : null;

  return (
    <div className="flex items-center gap-4 px-4 bg-bg-subtle border-b h-pricestrip">
      <span className="font-mono text-sm">{active.selection?.code}</span>
      <span className="text-lg font-semibold font-mono">
        {rightClose != null ? rightClose.toLocaleString('ko-KR') : '—'}
      </span>
      {delta != null && (
        <span
          className={`font-mono text-sm ${
            delta > 0 ? 'text-price-up' : delta < 0 ? 'text-price-down' : 'text-fg-dim'
          }`}
        >
          {delta > 0 ? '+' : ''}
          {delta.toFixed(2)}%
        </span>
      )}
      <SourceChip source={lastSegmentSource} />
    </div>
  );
}
