import { describe, expect, it } from 'vitest';
import {
  paneGroupIds,
  paneGroupSpecsForTimeframe,
  paneGroupStretch,
} from './paneGroupSpecs';
import { mergePaneIntoGroup, normalizePaneGroups } from '../chart/paneGroups';
import type { PaneToggles } from './paneSpecsForTimeframe';

const ALL_ON: PaneToggles = { foreignNet: true, institutionNet: true };

describe('paneGroupSpecsForTimeframe', () => {
  it('전 그룹 싱글턴이면 flat 게이트 결과와 같은 pane 목록이다 (병합 무영향 회귀선)', () => {
    const groups = paneGroupSpecsForTimeframe('1m', ALL_ON, normalizePaneGroups(undefined));
    expect(groups.map((g) => g.map((s) => s.name))).toEqual([
      ['candle'], ['volume'], ['quote-totals'], ['ratio'], ['fill-strength'], ['program-trade'],
      // investor 2종은 D 전용 게이트라 분봉에선 빠진다.
    ]);
  });

  it('게이트로 빠진 멤버는 그룹에서 사라지고, 전원 빠진 그룹은 pane 자체가 안 생긴다', () => {
    // {volume, investor-foreign} 병합 + {investor-institution} 싱글턴.
    const merged = mergePaneIntoGroup(normalizePaneGroups(undefined), 'investor-foreign', 'volume');
    const minute = paneGroupSpecsForTimeframe('1m', ALL_ON, merged);
    // 분봉: investor 게이트 탈락 → volume 만 남고, investor-institution 그룹은 소멸.
    expect(minute.map((g) => g.map((s) => s.name))).toContainEqual(['volume']);
    expect(minute.flat().map((s) => s.name)).not.toContain('investor-foreign');
    expect(minute.flat().map((s) => s.name)).not.toContain('investor-institution');
    // D: 병합 그룹이 온전히 마운트된다(호가 3종은 D 게이트 탈락).
    const daily = paneGroupSpecsForTimeframe('D', ALL_ON, merged);
    expect(daily.map((g) => g.map((s) => s.name))).toContainEqual(['volume', 'investor-foreign']);
  });

  it('identity 2층 캐시 — 같은 입력이면 같은 파티션, 무관한 그룹 편집에도 그룹 배열은 유지', () => {
    const base = normalizePaneGroups(undefined);
    const a = paneGroupSpecsForTimeframe('1m', ALL_ON, base);
    const b = paneGroupSpecsForTimeframe('1m', ALL_ON, base);
    expect(a).toBe(b);
    // ratio↔fill-strength 병합은 volume 그룹과 무관 — volume 그룹 배열 identity 유지.
    const merged = mergePaneIntoGroup(base, 'fill-strength', 'ratio');
    const c = paneGroupSpecsForTimeframe('1m', ALL_ON, merged);
    const volumeOf = (
      groups: ReturnType<typeof paneGroupSpecsForTimeframe>,
    ) => groups.find((g) => g[0].name === 'volume');
    expect(c).not.toBe(a);
    expect(volumeOf(c)).toBe(volumeOf(a));
    // paneGroupIds 도 같은 캐시 규율(그룹 identity → ids identity).
    expect(paneGroupIds(volumeOf(c)!)).toBe(paneGroupIds(volumeOf(a)!));
  });
});

describe('paneGroupStretch', () => {
  it('그룹 stretch = 멤버 유효 stretch(저장값 ?? 스펙 기본값)의 최대값', () => {
    const merged = mergePaneIntoGroup(normalizePaneGroups(undefined), 'ratio', 'volume');
    const daily = paneGroupSpecsForTimeframe('1m', ALL_ON, merged);
    const group = daily.find((g) => g[0].name === 'volume')!;
    // 스펙 기본값: volume 0.3 · ratio 0.4 → max 0.4
    expect(paneGroupStretch(group, {})).toBeCloseTo(0.4);
    // 저장값이 있으면 그것이 이긴다.
    expect(paneGroupStretch(group, { volume: 1.2 })).toBeCloseTo(1.2);
  });
});
