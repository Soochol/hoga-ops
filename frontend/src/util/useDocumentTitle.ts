import { useEffect } from 'react';
import { useSymbols } from '../capture/useSymbols';
import { useQuoteByCode, type LiveQuote } from '../api/liveQuotes';

const DEFAULT_TITLE = 'hoga-ops';

function formatTitlePrice(price: number): string {
  return price.toLocaleString('ko-KR');
}

function formatTitleChangePct(pct: number | null): string | null {
  if (pct === null) return null;
  return `${pct > 0 ? '+' : ''}${pct.toFixed(2)}%`;
}

function formatTitleBase(base: string, quote: LiveQuote | undefined): string {
  if (!quote) return base;
  const parts = [base, formatTitlePrice(quote.price)];
  const pct = formatTitleChangePct(quote.change_pct);
  if (pct) parts.push(pct);
  return parts.join(' ');
}

/**
 * Sole writer to `document.title`. Resolves a Code to its Symbol Master name;
 * falls back to the Code itself, then to `'hoga-ops'`. When the live quote cache
 * has the active code, appends current price and non-null change percent.
 *
 * See: docs/superpowers/specs/2026-05-29-browser-tab-title-design.md
 */
export function useDocumentTitle(code: string | null | undefined): void {
  const trimmed = code?.trim() || null;
  const { data } = useSymbols();
  const quoteByCode = useQuoteByCode(trimmed ? [trimmed] : []);
  const quote = trimmed ? quoteByCode.get(trimmed) : undefined;

  useEffect(() => {
    const name = trimmed
      ? data?.symbols.find((s) => s.code === trimmed)?.name
      : undefined;
    const base = name ?? trimmed;
    document.title = base ? formatTitleBase(base, quote) : DEFAULT_TITLE;
    return () => {
      document.title = DEFAULT_TITLE;
    };
  }, [trimmed, data, quote]);
}
