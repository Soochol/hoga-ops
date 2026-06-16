import type { WatchlistEntry } from '../api/watchlist';
import type { FolderGroup } from '../watchlist/grouping';
import type { LiveQuote } from '../api/liveQuotes';
import { makeChangePctOf, sortEntriesByChangePct } from '../rightrail/quoteSort';

export type SortMode = 'change' | 'manual';
export const HEAT_SAT = 8;          // 포화 임계(%)
export const HEAT_MAX_ALPHA = 0.42; // 기본 최대 알파(폴백 기본값)
/** 등락률 → 배경 rgba. null/0 = 투명(카드 배경 노출). ±HEAT_SAT% 포화.
 *  maxAlpha 로 면적별 농도 조절. */
export function heatBg(pct: number | null, maxAlpha: number = HEAT_MAX_ALPHA): string {
  if (pct === null || pct === 0) return 'transparent';
  const a = Math.min(Math.abs(pct) / HEAT_SAT, 1) * maxAlpha;
  const rgb = pct > 0 ? '220,38,38' : '37,99,235'; // --price-up / --price-down
  return `rgba(${rgb},${a.toFixed(3)})`;
}


export const HEAT_HEADER_MAX_ALPHA = 0.5; // 헤더 밴드용(큰 면적, 선형 램프) — ±8% 포화 시 최대 농도

/** 그룹 헤더 밴드 배경 = var(--bg-input) 위에 평균 등락 비례 히트(선형 램프) 합성.
 *  null/0 = 순수 var(--bg-input)(평면). ±HEAT_SAT% 포화. 동색 2-stop이라 시각상 단색 틴트
 *  (공간 그라데이션 아님 — DESIGN.md "no gradients" 장식 규율과 무충돌). */
export function heatHeaderBg(pct: number | null): string {
  if (pct === null || pct === 0) return 'var(--bg-input)';
  const a = Math.min(Math.abs(pct) / HEAT_SAT, 1) * HEAT_HEADER_MAX_ALPHA;
  const rgb = pct > 0 ? '220,38,38' : '37,99,235'; // --price-up / --price-down
  const heat = `rgba(${rgb},${a.toFixed(3)})`;
  return `linear-gradient(0deg, ${heat}, ${heat}), var(--bg-input)`;
}

/** quoteByCode → (code → 등락률|null) 접근자 팩토리. Map miss·change_pct=null 둘 다 null로
 *  접는 정책을 한 곳에 모은다(헤더 틴트·strip 칩·그룹 정렬이 공유). sortEntries/avgPct/
 *  orderFolderGroups의 pctOf 파라미터와 동형. */
export function makePctOf(quoteByCode: Map<string, LiveQuote>): (code: string) => number | null {
  return makeChangePctOf(quoteByCode);
}

/** 폴더 내 정렬. change=등락률 내림차순(null 맨 아래), manual=entry.order. 비파괴(복사). */
export function sortEntries(
  entries: WatchlistEntry[],
  mode: SortMode,
  pctOf: (code: string) => number | null,
): WatchlistEntry[] {
  return sortEntriesByChangePct(entries, pctOf, mode === 'manual' ? 'default' : 'change_pct_desc');
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

export type GroupSort = 'manual' | 'desc' | 'asc';

/** 그룹(폴더) 순서. 'manual'=입력 순서 그대로(folder.order, 미분류 맨 끝).
 *  'desc'/'asc'=실폴더를 평균 등락(avgOf)으로 정렬, avg=null인 실폴더는 실폴더 구간
 *  끝에(원순서 안정), 미분류(folder=null)는 **항상 맨 끝** 고정. 비파괴(복사). */
export function orderFolderGroups(
  groups: FolderGroup[],
  mode: GroupSort,
  avgOf: (g: FolderGroup) => number | null,
): FolderGroup[] {
  if (mode === 'manual') return groups;
  const real = groups.map((g, i) => ({ g, i })).filter((x) => x.g.folder !== null);
  const uncat = groups.filter((g) => g.folder === null);
  real.sort((a, b) => {
    const pa = avgOf(a.g);
    const pb = avgOf(b.g);
    if (pa === null && pb === null) return a.i - b.i; // 원순서 안정
    if (pa === null) return 1;
    if (pb === null) return -1;
    return mode === 'desc' ? pb - pa : pa - pb;
  });
  return [...real.map((x) => x.g), ...uncat];
}
