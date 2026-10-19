import { useCallback, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react';
import type { LiveQuote } from '../api/liveQuotes';

type Figures = { price: string[]; percent: string[] };
const patterns = (values: string[]) => [...new Set(values.map(value => value.replace(/\d/g, '8')))];

/** The unfiltered list includes collapsed groups and actual/expected figures.
 * Keep observed patterns while open so ticks/search do not move column edges.
 * There is one probe and observer for the panel, never one per row. */
export function useWatchlistColumns(codes: readonly string[], quotes: ReadonlyMap<string, LiveQuote>, scrollRef: RefObject<HTMLDivElement | null>) {
  const [retained, setRetained] = useState<Figures>({ price: ['—'], percent: ['+88.88%', '-88.88%'] });
  const samples = useMemo(() => {
    const price = [...retained.price], percent = [...retained.percent];
    for (const code of codes) {
      const quote = quotes.get(code);
      if (!quote) continue;
      for (const value of [quote.price, quote.expected_price]) {
        if (value != null) price.push(value.toLocaleString('ko-KR'));
      }
      for (const value of [quote.change_pct, quote.expected_change_pct]) {
        if (value != null) {
          const magnitude = Math.abs(value).toFixed(2);
          percent.push(`+${magnitude}%`, `-${magnitude}%`);
        }
      }
    }
    const next = { price: patterns(price), percent: patterns(percent) };
    return next.price.length === retained.price.length && next.percent.length === retained.percent.length ? retained : next;
  }, [codes, quotes, retained]);
  if (samples !== retained) setRetained(samples);
  const probe = useRef<HTMLSpanElement>(null);
  const [metrics, setMetrics] = useState({ price: 0, percent: 0, tier: 1 });
  const measure = useCallback(() => {
    if (!probe.current || !scrollRef.current) return;
    const width = scrollRef.current.clientWidth;
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    const widest = (column: keyof Figures) => Math.ceil(Math.max(0, ...Array.from(
      probe.current!.querySelectorAll(`[data-watchlist-measure="${column}"]`), node => node.getBoundingClientRect().width,
    )));
    const next = { price: widest('price'), percent: widest('percent'), tier: width > 20 * rem ? 0 : width > 16.25 * rem ? 1 : 2 };
    setMetrics(old => old.price === next.price && old.percent === next.percent && old.tier === next.tier ? old : next);
  }, [scrollRef]);
  useLayoutEffect(() => {
    measure();
    if (typeof ResizeObserver === 'undefined' || !probe.current || !scrollRef.current) return;
    const observer = new ResizeObserver(measure);
    observer.observe(scrollRef.current);
    probe.current.querySelectorAll('[data-watchlist-measure]').forEach(node => observer.observe(node));
    return () => observer.disconnect();
  }, [samples, measure, scrollRef]);
  const layout = useMemo(() => ({
    '--quote-price-width': metrics.price ? `${metrics.price}px` : '4.75rem',
    '--quote-percent-width': metrics.percent ? `${metrics.percent}px` : '3.5rem',
    '--quote-column-gap': ['0.5rem', '0.25rem', '0.125rem'][metrics.tier],
    '--quote-right-padding': ['0.75rem', '0.5rem', '0.25rem'][metrics.tier],
  }) as CSSProperties, [metrics]);
  return { probe, samples, layout };
}
