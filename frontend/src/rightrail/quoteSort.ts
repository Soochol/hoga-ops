import { type LiveQuote } from '../api/liveQuotes';

export type QuoteSortMode = 'default' | 'change_pct_asc' | 'change_pct_desc';
export interface QuoteSortableEntry {
  code: string;
  order: number;
}

// stale quote(kis_capacity_timeout·rest_bypass 등)의 change_pct 도 정렬키로 쓴다: 백엔드가
// 보존한 마지막 정상값이라 순서/집계에는 "몇 초 전 값"이 "값 없음"보다 항상 낫다(순서 안정성).
// stale 을 null 로 접으면 235종목 폴링에서 stale 배치가 올 때마다 전 종목 정렬키가 사라져
// 정렬이 order 폴백으로 리셋되고 섹터 스트립이 사라진다(주기적 리셋 버그). 표시 셀도 이미
// stale 값을 그대로 보여주므로(HeatmapFolder) 정렬만 값 없음 취급하던 자기모순을 해소한다.
// 신선도가 중요한 소비자(탭 제목·현재가 라인)는 별도로 isStaleLiveQuote 게이트를 유지한다.
export function makeChangePctOf(quoteByCode: Map<string, LiveQuote>): (code: string) => number | null {
  return (code) => {
    const pct = quoteByCode.get(code)?.change_pct;
    return typeof pct === 'number' && Number.isFinite(pct) ? pct : null;
  };
}

export function sortEntriesByChangePct<TEntry extends QuoteSortableEntry>(
  entries: TEntry[],
  pctOf: (code: string) => number | null,
  mode: QuoteSortMode,
): TEntry[] {
  if (mode === 'default') return [...entries].sort((a, b) => a.order - b.order);

  const dir = mode === 'change_pct_asc' ? 1 : -1;
  return entries
    .map((entry) => ({ entry, pct: pctOf(entry.code) }))
    .sort((a, b) => {
      if (a.pct == null && b.pct == null) return a.entry.order - b.entry.order;
      if (a.pct == null) return 1;
      if (b.pct == null) return -1;
      const byPct = (a.pct - b.pct) * dir;
      return byPct === 0 ? a.entry.order - b.entry.order : byPct;
    })
    .map((x) => x.entry);
}
