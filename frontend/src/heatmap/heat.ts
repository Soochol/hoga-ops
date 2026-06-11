import type { WatchlistEntry } from '../api/watchlist';

export type SortMode = 'change' | 'manual';
export const HEAT_SAT = 8;          // 포화 임계(%)
export const HEAT_MAX_ALPHA = 0.42; // 기본 최대 알파(폴백 기본값)
export const HEAT_CHIP_MAX_ALPHA = 0.72; // 등락률 칩용 — 작은 면적이라 더 진하게 칠해야 색이 또렷

/** 등락률 → 배경 rgba. null/0 = 투명(카드 배경 노출). ±HEAT_SAT% 포화.
 *  maxAlpha 로 면적별 농도 조절: 등락률 칩은 HEAT_CHIP_MAX_ALPHA(0.72)로 호출한다. */
export function heatBg(pct: number | null, maxAlpha: number = HEAT_MAX_ALPHA): string {
  if (pct === null || pct === 0) return 'transparent';
  const a = Math.min(Math.abs(pct) / HEAT_SAT, 1) * maxAlpha;
  const rgb = pct > 0 ? '220,38,38' : '37,99,235'; // --price-up / --price-down
  return `rgba(${rgb},${a.toFixed(3)})`;
}

/** 등락률 칩 전용 배경 — 그라데이션(연속 램프) 없이 |등락률| ≥ HEAT_SAT(8%)일 때만 평면색
 *  (HEAT_CHIP_MAX_ALPHA 단일 농도). 그 미만·결측·0 은 투명 → 급등락 종목만 배경이 칠해진다.
 *  평균칩·섹터 스트립은 그대로 heatBg(연속 램프)를 쓴다 — 칩만 임계 방식. */
export function heatChipBg(pct: number | null): string {
  if (pct === null || Math.abs(pct) < HEAT_SAT) return 'transparent';
  const rgb = pct > 0 ? '220,38,38' : '37,99,235'; // --price-up / --price-down
  return `rgba(${rgb},${HEAT_CHIP_MAX_ALPHA.toFixed(3)})`;
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
