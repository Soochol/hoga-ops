import { describe, expect, it } from 'vitest';
import { mergeByHeadroom, sinceFor, visibleRows, PERIODS } from './patternConditions';

/**
 * 조건이 어디서 걸리는지, 그리고 길이별 결과를 **어떻게 합치는지**.
 *
 * 병합의 요점: 길이마다 배경 분포가 달라 원점수로 섞으면 짧은 쪽이 도배한다.
 * 그 성질을 값으로 재는 것이 이 파일의 핵심 가드다.
 */

const row = (corr: number, code = 'a') => ({
  code, name: code, from_date: '20240101', to_date: '20240107', corr,
  bars: [[1, 1, 1, 1]], tail: null, forward_pct: null, ma: null,
});

describe('mergeByHeadroom', () => {
  it('원점수가 아니라 **p99.99 대비 여유**로 줄 세운다', () => {
    // 짧은 길이는 점수가 높지만 배경도 높다 — 여유로 보면 긴 쪽이 앞선다.
    const merged = mergeByHeadroom([
      { length: 7, dist: { p99_99: 0.93, p99: 0.8 }, matches: [row(0.95, 'short')] },
      { length: 14, dist: { p99_99: 0.83, p99: 0.7 }, matches: [row(0.90, 'long')] },
    ]);
    expect(merged.map((m) => m.row.code)).toEqual(['long', 'short']);
    // ★ 원점수로 섞었다면 short(0.95)가 앞선다 — 그게 실측에서 본 도배다.
    expect(merged[0].headroom).toBeCloseTo(0.07, 5);
  });

  it('p99.99 가 없으면(now 모드) p99 로 대신한다', () => {
    const merged = mergeByHeadroom([
      { length: 7, dist: { p99_99: null, p99: 0.8 }, matches: [row(0.9)] },
    ]);
    expect(merged[0].headroom).toBeCloseTo(0.1, 5);
  });

  it('길이 정보를 잃지 않는다 — 행 뱃지가 그 값을 쓴다', () => {
    const merged = mergeByHeadroom([
      { length: 10, dist: { p99_99: 0.8, p99: 0.7 }, matches: [row(0.9)] },
    ]);
    expect(merged[0].length).toBe(10);
  });
});

describe('sinceFor', () => {
  it('전체 기간은 undefined — 서버가 필터를 아예 안 건다', () => {
    expect(sinceFor('all')).toBeUndefined();
  });

  it('상대 기간을 YYYYMMDD 로 되돌린다', () => {
    expect(sinceFor('3y', new Date('2026-09-02'))).toBe('20230902');
    expect(sinceFor('1y', new Date('2026-09-02'))).toBe('20250902');
  });
});

describe('visibleRows', () => {
  it('하한을 먼저 적용하고 개수로 자른다 — 순서가 반대면 하한이 헛돈다', () => {
    const rows = [row(0.95, 'a'), row(0.85, 'b'), row(0.80, 'c')];
    expect(visibleRows(rows, { simFloor: 0.9, count: 10 }).map((r) => r.code)).toEqual(['a']);
    expect(visibleRows(rows, { simFloor: 0, count: 2 }).map((r) => r.code)).toEqual(['a', 'b']);
  });
});

describe('PERIODS — 1~5년을 모두 고를 수 있다', () => {
  it('1·2·3·4·5년과 전체가 후보다', () => {
    expect(PERIODS.map((p) => p.key)).toEqual(['all', '5y', '4y', '3y', '2y', '1y']);
    // 라벨과 연수가 어긋나면 화면이 거짓말한다 — 「최근 4년」을 골랐는데 3년이 가는 식.
    for (const p of PERIODS) {
      if (p.years === null) continue;
      expect(p.label).toBe(`최근 ${p.years}년`);
    }
  });
});
