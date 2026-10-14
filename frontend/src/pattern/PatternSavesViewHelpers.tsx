import type { PatternSave } from '../api/screener';


/** 항목의 둘째 줄 — 종목은 그룹 헤더가 이미 말하므로 **조건만** 남긴다. */
export function conditionLine(save: PatternSave): string {
  const c = save.conditions;
  const period = c.since
    ? `${c.since.slice(0, 4)}-${c.since.slice(4, 6)} 이후`
    : '전체 기간';
  const parts = [period, `${c.count}개`];
  if (c.sim_floor > 0) parts.push(`유사도 ${c.sim_floor.toFixed(2)}+`);
  if (c.volume_weight > 0) parts.push('거래량');
  return parts.join(' · ');
}
