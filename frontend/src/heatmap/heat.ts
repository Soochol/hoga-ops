import type { WatchlistEntry } from '../api/watchlist';

export type SortMode = 'change' | 'manual';
export const HEAT_SAT = 8;          // 포화 임계(%)
export const HEAT_MAX_ALPHA = 0.42; // 하이브리드 최대 알파(텍스트 가독 한계)

/** 등락률 → 배경 rgba. null/0 = 투명(카드 배경 노출). ±HEAT_SAT% 포화. */
export function heatBg(pct: number | null): string {
  if (pct === null || pct === 0) return 'transparent';
  const a = Math.min(Math.abs(pct) / HEAT_SAT, 1) * HEAT_MAX_ALPHA;
  const rgb = pct > 0 ? '220,38,38' : '37,99,235'; // --price-up / --price-down
  return `rgba(${rgb},${a.toFixed(3)})`;
}

/** 폴더 내 정렬. change=등락률 내림차순(null 맨 아래), manual=entry.order. 비파괴(복사). */
export function sortEntries(
  entries: WatchlistEntry[],
  mode: SortMode,
  pctOf: (code: string) => number | null,
): WatchlistEntry[] {
  if (mode === 'manual') return [...entries].sort((a, b) => a.order - b.order);
  return [...entries].sort((a, b) => {
    const pa = pctOf(a.code);
    const pb = pctOf(b.code);
    if (pa === null && pb === null) return a.order - b.order;
    if (pa === null) return 1;
    if (pb === null) return -1;
    return pb - pa;
  });
}

/** 섹터 온도 = 시세 도착 종목의 비가중 평균 등락률. 전부 결측이면 null. */
export function avgPct(
  entries: WatchlistEntry[],
  pctOf: (code: string) => number | null,
): number | null {
  const vals = entries.map((e) => pctOf(e.code)).filter((v): v is number => v !== null);
  if (vals.length === 0) return null;
  return vals.reduce((s, v) => s + v, 0) / vals.length;
}
