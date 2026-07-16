import { useEffect } from 'react';
import { useSymbols } from '../capture/useSymbols';
import { useQuoteByCode, type LiveQuote } from '../api/liveQuotes';
import { useLiveVenueStore } from '../state/liveVenue';

const DEFAULT_TITLE = 'hoga-ops';

function formatTitlePrice(price: number): string {
  return price.toLocaleString('ko-KR');
}

function formatTitleChangePct(pct: number | null): string | null {
  if (pct === null) return null;
  return `${pct > 0 ? '+' : ''}${pct.toFixed(2)}%`;
}

function formatTitleBase(base: string, quote: LiveQuote | undefined): string {
  // stale quote(kis_capacity_timeout 등 장중 일시 미응답 시 last-good 값)도 그대로 붙인다.
  // stale 을 숨기면 235종목 폴링에서 stale 배치가 올 때마다 탭 제목의 가격·등락률이 사라졌다
  // 나타나며 깜빡인다 — 값은 수 초 전 last-good 이라 탭 제목엔 충분히 정확하고, 탭 제목엔
  // 신선도 표식이 없어 숨기면 정보만 잃는다. 정렬/집계와 동일 정책(makeChangePctOf 주석 참조).
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
  const venue = useLiveVenueStore((s) => s.venue);
  const quoteByCode = useQuoteByCode(trimmed ? [trimmed] : [], venue);
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

export function useStaticDocumentTitle(title: string | null | undefined): void {
  const resolved = title?.trim() || DEFAULT_TITLE;

  useEffect(() => {
    document.title = resolved;
    return () => {
      document.title = DEFAULT_TITLE;
    };
  }, [resolved]);
}
