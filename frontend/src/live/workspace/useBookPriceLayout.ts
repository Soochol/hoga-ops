import { useState, type CSSProperties } from 'react';

/** Keep a symbol's digit budget until it changes; only grow at a price-band boundary.
 * CSS ch units follow the active font without measuring every incoming quote. */
export function useBookPriceLayout(levels: readonly { price: number }[], symbol: string, averageMarker: boolean, baselinePrice: number | null = null, showPercent = true): CSSProperties {
  let requiredDigits = 5;
  let requiredPercent = '—';
  for (const { price } of levels) {
    if (!Number.isSafeInteger(price) || price <= 0) continue;
    requiredDigits = Math.max(requiredDigits, String(price).length);
    if (baselinePrice !== null && Number.isFinite(baselinePrice) && baselinePrice > 0) {
      const pct = (price - baselinePrice) / baselinePrice * 100;
      const sample = `${pct > 0 ? '+' : ''}${pct.toFixed(2)}%`.replace(/\d/g, '8');
      if (sample.length > requiredPercent.length || (sample.length === requiredPercent.length && sample.startsWith('+'))) requiredPercent = sample;
    }
  }
  const [budget, setBudget] = useState({ symbol, digits: requiredDigits, percent: requiredPercent });
  const digits = budget.symbol === symbol ? Math.max(budget.digits, requiredDigits) : requiredDigits;
  const percent = budget.symbol !== symbol || requiredPercent.length > budget.percent.length
    || (requiredPercent.length === budget.percent.length && requiredPercent.startsWith('+')) ? requiredPercent : budget.percent;
  if (budget.symbol !== symbol || budget.digits !== digits || budget.percent !== percent) setBudget({ symbol, digits, percent });
  const commas = Math.floor((digits - 1) / 3);
  // Order: day 16 + dot 12 + gaps 6; book: day 16 + gap 4 (14px less).
  const markerDifference = averageMarker ? 0 : 14;
  const minimum = (digits >= 8 ? 160 : digits >= 7 ? 144 : 128) - markerDifference - (showPercent ? 0 : 50);
  return {
    // Reserve a full figure for each separator, including fallback font metrics.
    '--book-price-width': `max(${minimum}px, calc(${digits + commas}ch + var(--book-day-width) + ${(showPercent ? 30 : 34) - markerDifference}px${showPercent ? ' + max(48px, 6.4ch)' : ''}))`,
    '--book-price-sample': JSON.stringify('8'.repeat(digits).replace(/\B(?=(\d{3})+(?!\d))/g, ',')),
    '--book-percent-sample': JSON.stringify(percent),
  } as CSSProperties;
}
