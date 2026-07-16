import type { HeatmapEntry, HeatmapFolder } from '../api/heatmap';
import type { LiveQuote } from '../api/liveQuotes';
import { makeChangePctOf, sortEntriesByChangePct, type QuoteSortMode } from '../rightrail/quoteSort';

/** 히트맵 그룹 = 실폴더 + 소속 종목. v3 (ADR-0112): folder 는 항상 non-null —
 *  미분류(render-only null 그룹, 구 ADR-0068 G3)는 존재하지 않는다. watchlist 의
 *  FolderGroup(folder: … | null)과 구분되는 히트맵 전용 모양. */
export interface HeatmapGroup {
  folder: HeatmapFolder;
  entries: HeatmapEntry[];
}

/** 폴더·종목을 표시용 그룹으로 묶는다. 폴더는 `.order`순, 그룹 내 종목도 `.order`순.
 *  빈 폴더 포함(드로어가 "새 그룹 직후 종목 추가" 흐름을 보여야 함 — 보드는
 *  visibleFolderGroups 가 빈 그룹을 걸러낸다). 순수(비파괴). */
export function groupHeatmapEntries(
  folders: HeatmapFolder[],
  entries: HeatmapEntry[],
): HeatmapGroup[] {
  const byOrder = (a: HeatmapEntry, b: HeatmapEntry) => a.order - b.order;
  return [...folders].sort((a, b) => a.order - b.order).map((folder) => ({
    folder,
    entries: entries.filter((e) => e.folder_id === folder.id).sort(byOrder),
  }));
}

// 행(종목)·그룹 정렬 공용 3-상태: manual=기본(저장 순서), desc=등락률 내림, asc=오름.
// 관심종목의 QuoteSortMode(default/change_pct_desc/change_pct_asc)와 1:1 대응(아이콘 공용).
export type SortMode = 'manual' | 'desc' | 'asc';
export const HEAT_SAT = 8;          // 포화 임계(%)
export const HEAT_MAX_ALPHA = 0.42; // 기본 최대 알파(폴백 기본값)
/** 등락률 → 배경 색. null/0 = 투명(카드 배경 노출). ±HEAT_SAT% 포화.
 *  maxAlpha 로 면적별 농도 조절. color-mix 로 var(--price-*) 를 참조하므로
 *  테마(Obsidian/Ledger) 전환 시 시세 색이 자동 추종한다. */
export function heatBg(pct: number | null, maxAlpha: number = HEAT_MAX_ALPHA): string {
  if (pct === null || pct === 0) return 'transparent';
  const a = Math.min(Math.abs(pct) / HEAT_SAT, 1) * maxAlpha;
  const token = pct > 0 ? 'var(--price-up)' : 'var(--price-down)';
  return `color-mix(in srgb, ${token} ${(a * 100).toFixed(1)}%, transparent)`;
}


export const HEAT_HEADER_MAX_ALPHA = 0.5; // 헤더 밴드용(큰 면적, 선형 램프) — ±8% 포화 시 최대 농도

/** 그룹 헤더 밴드 배경 = var(--bg-input) 위에 평균 등락 비례 히트(선형 램프) 합성.
 *  null/0 = 순수 var(--bg-input)(평면). ±HEAT_SAT% 포화. 동색 2-stop이라 시각상 단색 틴트
 *  (공간 그라데이션 아님 — DESIGN.md "no gradients" 장식 규율과 무충돌). */
export function heatHeaderBg(pct: number | null): string {
  if (pct === null || pct === 0) return 'var(--bg-input)';
  const a = Math.min(Math.abs(pct) / HEAT_SAT, 1) * HEAT_HEADER_MAX_ALPHA;
  const token = pct > 0 ? 'var(--price-up)' : 'var(--price-down)'; // 테마 자동 추종
  const heat = `color-mix(in srgb, ${token} ${(a * 100).toFixed(1)}%, transparent)`;
  return `linear-gradient(0deg, ${heat}, ${heat}), var(--bg-input)`;
}

/** quoteByCode → (code → 등락률|null) 접근자 팩토리. Map miss·change_pct=null 만 null로
 *  접고 stale 값은 정렬키로 유지하는 정책은 makeChangePctOf가 소유(헤더 틴트·strip 칩·
 *  그룹 정렬이 공유). sortEntries/avgPct/orderFolderGroups의 pctOf 파라미터와 동형. */
export function makePctOf(quoteByCode: Map<string, LiveQuote>): (code: string) => number | null {
  return makeChangePctOf(quoteByCode);
}

/** 정렬 순환: 기본(manual) → 내림(desc) → 오름(asc) → 기본. 아이콘 순환 버튼(SortCycleButton)
 *  이 클릭마다 진행하는 단일 순서 — /heatmap 페이지와 우측 레일 드로어가 공유. */
export function nextSort(mode: SortMode): SortMode {
  return mode === 'manual' ? 'desc' : mode === 'desc' ? 'asc' : 'manual';
}

/** SortMode/GroupSort(3-상태) → QuoteSortMode. manual=default(기본), desc=내림, asc=오름.
 *  정렬키 계산(sortEntries)과 통합 정렬 아이콘(QuoteSortIcon)이 공유하는 단일 매핑. */
export function toQuoteSortMode(mode: 'manual' | 'desc' | 'asc'): QuoteSortMode {
  if (mode === 'desc') return 'change_pct_desc';
  if (mode === 'asc') return 'change_pct_asc';
  return 'default';
}

/** 폴더 내 정렬. desc=등락률 내림차순·asc=오름차순(둘 다 null 맨 아래), manual=entry.order.
 *  비파괴(복사). */
export function sortEntries(
  entries: HeatmapEntry[],
  mode: SortMode,
  pctOf: (code: string) => number | null,
): HeatmapEntry[] {
  return sortEntriesByChangePct(entries, pctOf, toQuoteSortMode(mode));
}

/** 섹터 온도 = 시세 도착 종목의 비가중 평균 등락률. 전부 결측이면 null. */
export function avgPct(
  entries: HeatmapEntry[],
  pctOf: (code: string) => number | null,
): number | null {
  const vals = entries.map((e) => pctOf(e.code)).filter((v): v is number => v !== null);
  if (vals.length === 0) return null;
  return vals.reduce((s, v) => s + v, 0) / vals.length;
}

export type GroupSort = 'manual' | 'desc' | 'asc';

/** 그룹(폴더) 순서. 'manual'=입력 순서 그대로(folder.order).
 *  'desc'/'asc'=평균 등락(avgOf)으로 정렬, avg=null인 폴더는 끝에(원순서 안정).
 *  비파괴(복사). */
export function orderFolderGroups(
  groups: HeatmapGroup[],
  mode: GroupSort,
  avgOf: (g: HeatmapGroup) => number | null,
): HeatmapGroup[] {
  if (mode === 'manual') return groups;
  const indexed = groups.map((g, i) => ({ g, i }));
  indexed.sort((a, b) => {
    const pa = avgOf(a.g);
    const pb = avgOf(b.g);
    if (pa === null && pb === null) return a.i - b.i; // 원순서 안정
    if (pa === null) return 1;
    if (pb === null) return -1;
    return mode === 'desc' ? pb - pa : pa - pb;
  });
  return indexed.map((x) => x.g);
}
