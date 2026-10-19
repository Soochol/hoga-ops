import { useCallback, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react';
import type { LiveQuote } from '../api/liveQuotes';

type Figures = { price: string[]; percent: string[] };
type QuoteColumnValue = Pick<LiveQuote, 'change_pct' | 'expected_price' | 'expected_change_pct'> & { price: number | null };
const initialFigures = (): Figures => ({ price: ['—'], percent: ['+88.88%', '-88.88%'] });
const patterns = (values: string[]) => [...new Set(values.map(value => value.replace(/\d/g, '8')))];

/** The unfiltered list includes collapsed groups and actual/expected figures.
 * Keep observed patterns while open so ticks/search do not move column edges.
 * There is one probe and observer for the panel, never one per row. */
export function useQuoteColumns(codes: readonly string[], quotes: ReadonlyMap<string, QuoteColumnValue>, scrollRef: RefObject<HTMLDivElement | null>, scopeKey?: string | null) {
  const [budget, setBudget] = useState(() => ({ scopeKey: scopeKey ?? null, figures: initialFigures() }));
  const next = useMemo(() => {
    // A temporarily empty/loading result does not end the current scope. Only
    // an actual result with a different condition identity starts a new budget.
    const key = scopeKey ?? budget.scopeKey;
    const retained = key === budget.scopeKey ? budget.figures : initialFigures();
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
    return key === budget.scopeKey && next.price.length === retained.price.length && next.percent.length === retained.percent.length
      ? budget : { scopeKey: key, figures: next };
  }, [codes, quotes, budget, scopeKey]);
  if (next !== budget) setBudget(next);
  const samples = next.figures;
  const probe = useRef<HTMLSpanElement>(null);
  const [metrics, setMetrics] = useState({ price: 0, percent: 0, tier: 1 });
  const measure = useCallback(() => {
    if (!probe.current || !scrollRef.current) return;
    const width = scrollRef.current.clientWidth;
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    const widest = (column: keyof Figures) => Math.ceil(Math.max(0, ...Array.from(
      probe.current!.querySelectorAll(`[data-quote-measure="${column}"]`), node => node.getBoundingClientRect().width,
    )));
    const next = { price: widest('price'), percent: widest('percent'), tier: width > 20 * rem ? 0 : width > 16.25 * rem ? 1 : 2 };
    setMetrics(old => old.price === next.price && old.percent === next.percent && old.tier === next.tier ? old : next);
  }, [scrollRef]);
  useLayoutEffect(() => {
    measure();
    if (typeof ResizeObserver === 'undefined' || !probe.current || !scrollRef.current) return;
    // Apply resize-driven React updates in the next frame so a changed column
    // minimum/scrollbar cannot feed layout back into the same observer delivery.
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    });
    observer.observe(scrollRef.current);
    probe.current.querySelectorAll('[data-quote-measure]').forEach(node => observer.observe(node));
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, [samples, measure, scrollRef]);
  const layout = useMemo(() => ({
    '--quote-price-width': metrics.price ? `${metrics.price}px` : '4.75rem',
    '--quote-percent-width': metrics.percent ? `${metrics.percent}px` : '3.5rem',
    '--quote-column-gap': ['0.5rem', '0.25rem', '0.125rem'][metrics.tier],
    '--quote-right-padding': ['0.75rem', '0.5rem', '0.25rem'][metrics.tier],
  }) as CSSProperties, [metrics]);
  return { probe, samples, layout };
}
