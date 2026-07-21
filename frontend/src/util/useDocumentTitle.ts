import { useEffect, useRef } from 'react';
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

/** 가격→가격 갱신의 탭 제목 쓰기 스로틀 창.
 *
 *  시세 seam(useQuoteByCode)이 키움 WS 틱 오버레이(LIVE_FLUSH_MS 150ms)를 물려준
 *  뒤로, 체결마다 제목을 다시 쓰면 매수/매도 호가를 오가는 체결가가 탭 제목을
 *  초당 수 회 번갈아 바꿔 깜빡임으로 보인다(장중 실측 6.1s/10회). 탭 제목에
 *  sub-초 신선도는 무의미하므로 가격 갱신만 이 창으로 코얼레싱한다. 종목 전환·
 *  첫 시세 부착은 즉시 쓴다 — 지연되면 이전 종목명이 남아 그게 더 어긋난다. */
const TITLE_QUOTE_THROTTLE_MS = 2_000;

/**
 * Sole writer to `document.title`. Resolves a Code to its Symbol Master name;
 * falls back to the Code itself, then to `'hoga-ops'`. When the live quote cache
 * has the active code, appends current price and non-null change percent.
 * Price-to-price updates are coalesced to TITLE_QUOTE_THROTTLE_MS (trailing,
 * latest value wins); base/first-quote transitions write immediately.
 *
 * See: docs/superpowers/specs/2026-05-29-browser-tab-title-design.md
 */
export function useDocumentTitle(code: string | null | undefined): void {
  const trimmed = code?.trim() || null;
  const { data } = useSymbols();
  const venue = useLiveVenueStore((s) => s.venue);
  const quoteByCode = useQuoteByCode(trimmed ? [trimmed] : [], venue);
  const quote = trimmed ? quoteByCode.get(trimmed) : undefined;

  const name = trimmed
    ? data?.symbols.find((s) => s.code === trimmed)?.name
    : undefined;
  const base = name ?? trimmed;
  const title = base ? formatTitleBase(base, quote) : DEFAULT_TITLE;
  const hasQuote = quote !== undefined;

  const prevBaseRef = useRef<string | null>(null);
  const prevHasQuoteRef = useRef(false);
  const lastWriteMsRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // 즉시 쓰기 판정은 전이 종류로 한다: 종목(base) 전환과 무시세→시세 부착은
    // 지연 없이, 시세→시세만 스로틀. 시세→무시세도 스로틀 쪽에 둔다 — venue 전환
    // 등으로 quote 가 잠깐 빠졌다 돌아올 때 가격이 사라졌다 나타나며 깜빡이는
    // 동종 사고(formatTitleBase 주석의 stale 깜빡임)를 재발시키지 않기 위해서다.
    const immediate = prevBaseRef.current !== base || (hasQuote && !prevHasQuoteRef.current);
    prevBaseRef.current = base;
    prevHasQuoteRef.current = hasQuote;
    if (timerRef.current !== null) {
      // 대기 중인 쓰기는 항상 버리고 최신 title 로 다시 예약한다(latest wins).
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const write = () => {
      timerRef.current = null;
      document.title = title;
      lastWriteMsRef.current = Date.now();
    };
    const waitMs = lastWriteMsRef.current + TITLE_QUOTE_THROTTLE_MS - Date.now();
    if (immediate || waitMs <= 0) write();
    else timerRef.current = setTimeout(write, waitMs);
  }, [title, base, hasQuote]);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      document.title = DEFAULT_TITLE;
    };
  }, []);
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
