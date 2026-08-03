import { describe, expect, it } from 'vitest';

import {
  atmDomain,
  fullDomain,
  nearestStrike,
  strikeAt,
  ticksFor,
  xOf,
} from './strikeScale';

describe('도메인', () => {
  it('ATM 도메인은 기초자산 ±15% 를 전체 범위로 클램프한다', () => {
    const strikes = [625, 1000, 1597.5];
    const d = atmDomain(strikes, 990)!;
    expect(d.lo).toBeCloseTo(990 * 0.85);
    expect(d.hi).toBeCloseTo(990 * 1.15);
    // 기초자산이 왼쪽 끝에 붙어 있으면 lo 는 전체 최소로 클램프
    const edge = atmDomain(strikes, 640)!;
    expect(edge.lo).toBe(625);
  });

  it('기초자산이 없으면 전체로 폴백한다 — 중심을 지어내지 않는다', () => {
    const strikes = [625, 1597.5];
    expect(atmDomain(strikes, null)).toEqual(fullDomain(strikes));
    expect(atmDomain(strikes, 0)).toEqual(fullDomain(strikes));
  });

  it('빈 행사가 목록은 null', () => {
    expect(fullDomain([])).toBeNull();
    expect(atmDomain([], 990)).toBeNull();
  });
});

describe('픽셀 변환', () => {
  it('xOf 와 strikeAt 은 역함수다', () => {
    const d = { lo: 850, hi: 1150 };
    for (const k of [850, 1000, 1012.5, 1150]) {
      expect(strikeAt(d, xOf(d, k))).toBeCloseTo(k);
    }
  });
});

describe('눈금', () => {
  it('ATM 줌(~300p)이면 50 간격 라운드 눈금이 나온다', () => {
    const ticks = ticksFor({ lo: 841.5, hi: 1138.5 });
    expect(ticks).toEqual([850, 900, 950, 1000, 1050, 1100]);
  });

  it('전체(~1000p)이면 간격이 넓어져 9개를 넘지 않는다', () => {
    const ticks = ticksFor({ lo: 625, hi: 1597.5 });
    expect(ticks.length).toBeLessThanOrEqual(9);
    expect(ticks).toContain(1000);
    // 전부 라운드 값 — 625.0 같은 도메인 끝값이 눈금으로 새지 않는다
    for (const t of ticks) expect(t % 250 === 0 || t % 100 === 0).toBe(true);
  });
});

describe('호버 스냅', () => {
  it('가장 가까운 행사가로 스냅한다', () => {
    const strikes = [995, 997.5, 1000, 1002.5];
    expect(nearestStrike(strikes, 996.0)).toBe(995);
    expect(nearestStrike(strikes, 996.5)).toBe(997.5);
    expect(nearestStrike(strikes, 2000)).toBe(1002.5);
    expect(nearestStrike(strikes, 0)).toBe(995);
  });

  it('빈 배열이면 null — 값을 지어내지 않는다', () => {
    expect(nearestStrike([], 1000)).toBeNull();
  });
});
