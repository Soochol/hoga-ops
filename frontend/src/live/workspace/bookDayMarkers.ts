import type { LiveTradeSummary } from '../liveSidebarAdapters';

export type BookPriceMarker = { label: string; bg: string; tooltip: string };

// Array order preserves the one-badge-per-price policy: high > low > open.
const DAY_MARKERS = [
  { label: '고', name: '고가', bg: 'bg-price-up', of: (s: LiveTradeSummary) => s.dayHigh },
  { label: '저', name: '저가', bg: 'bg-price-down', of: (s: LiveTradeSummary) => s.dayLow },
  { label: '시', name: '시가', bg: 'bg-fg-dim', of: (s: LiveTradeSummary) => s.dayOpen },
] as const;

/** Attach each day price to the nearest displayed quote, only within the ladder.
 * Ties select the lower price regardless of ask/bid order. Zero-padding is never a quote. */
export function bookDayMarkers(prices: Iterable<number>, summary: LiveTradeSummary): Map<number, BookPriceMarker> {
  const levels = [...new Set(prices)].filter(price => Number.isFinite(price) && price > 0);
  const markers = new Map<number, BookPriceMarker>();
  if (levels.length === 0) return markers;
  const min = Math.min(...levels), max = Math.max(...levels);
  for (const marker of DAY_MARKERS) {
    const actual = marker.of(summary);
    if (actual == null || !Number.isFinite(actual) || actual <= 0 || actual < min || actual > max) continue;
    let nearest = levels[0];
    for (const price of levels) {
      const distance = Math.abs(price - actual), best = Math.abs(nearest - actual);
      if (distance < best || (distance === best && price < nearest)) nearest = price;
    }
    if (markers.has(nearest)) continue;
    const tooltip = `${marker.name} ${actual.toLocaleString('ko-KR')}원${nearest === actual
      ? '' : ` · 가장 가까운 호가 ${nearest.toLocaleString('ko-KR')}원`}`;
    markers.set(nearest, { label: marker.label, bg: marker.bg, tooltip });
  }
  return markers;
}
