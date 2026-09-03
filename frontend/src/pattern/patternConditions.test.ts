import { describe, expect, it } from 'vitest';
import {
  mergeByHeadroom, sinceFor, visibleRows, PERIODS, withWholeCodeExcluded, isExcludedRow,
  DEFAULT_CONDITIONS, defaultConditionsFor, forwardBarsFor, maLabel, periodIsThinFor,
} from './patternConditions';

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

describe('withWholeCodeExcluded — 종목 전체를 빼면 그 종목의 자리는 걷어낸다', () => {
  const e = (code: string, from_date: string | null) => ({ code, from_date, stock_name: code });

  it('같은 종목의 자리 제외를 대체한다 — 복원 목록이 한 줄이다', () => {
    const next = withWholeCodeExcluded(
      [e('000660', '20180307'), e('005930', '20240101'), e('000660', '20200505')],
      e('000660', null),
    );
    expect(next.filter((x) => x.code === '000660')).toEqual([e('000660', null)]);
    // 다른 종목은 건드리지 않는다.
    expect(next).toContainEqual(e('005930', '20240101'));
  });

  it('넘어온 entry 의 from_date 가 무엇이든 **전체**로 눌러 담는다', () => {
    // 호출부가 실수로 행의 날짜를 그대로 넘겨도 「그 자리」가 되지 않는다.
    expect(withWholeCodeExcluded([], e('000660', '20180307'))).toEqual([e('000660', null)]);
  });
});

describe('isExcludedRow — 종목 키가 모든 날짜를 덮는다', () => {
  const row = { code: '000660', from_date: '20180307' };

  it('자리 키는 그 날짜만 막는다', () => {
    expect(isExcludedRow(row, new Set(['000660:20180307']))).toBe(true);
    expect(isExcludedRow(row, new Set(['000660:20200505']))).toBe(false);
  });

  it('종목 키는 날짜와 무관하게 막는다 — 이게 없으면 「통째로 뺐는데 남는다」가 된다', () => {
    expect(isExcludedRow(row, new Set(['000660:*']))).toBe(true);
    expect(isExcludedRow({ code: '005930', from_date: '20180307' }, new Set(['000660:*']))).toBe(false);
  });
});

describe('봉 단위별 공장값·라벨', () => {
  /** 월봉 기간을 좁히면 후보가 사라진다 — 실측: 1년 **0** · 3년 12,625 · 5년 23,926 ·
   *  전체 69,018(일봉 1년이 121,920 이므로 그 아래가 「얇다」의 기준선이다). */
  it('월봉 공장 기간은 전체다 — 좁힐 여지가 없다', () => {
    expect(defaultConditionsFor('M').period).toBe('all');
    expect(defaultConditionsFor('W').period).toBe('3y');
    expect(defaultConditionsFor('D').period).toBe(DEFAULT_CONDITIONS.period);
  });

  it('수익률 지평은 봉을 센다 — 봉이 길수록 「이후」도 길다', () => {
    // 일봉 20일 ≈ 1개월 · 주봉 8봉 ≈ 2개월 · 월봉 3봉 = 3개월.
    expect(forwardBarsFor('D')).toBe(20);
    expect(forwardBarsFor('W')).toBe(8);
    expect(forwardBarsFor('M')).toBe(3);
  });

  it('이평 라벨이 단위를 진다 — 5·20 이 무엇의 5·20 인지', () => {
    expect(maLabel('short', 'D')).toBe('단기 5·20');
    expect(maLabel('short', 'W')).toBe('단기 5·20주');
    expect(maLabel('short', 'M')).toBe('단기 5·20개월');
    // 끄기에는 단위가 없다 — 「이평 끄기(주)」는 무의미하다.
    expect(maLabel('off', 'M')).toBe('이평 끄기');
  });

  it('얇은 기간은 봉마다 다르다 — 전체 기간은 어느 봉에서도 얇지 않다', () => {
    expect(periodIsThinFor('M', 1)).toBe(true);
    expect(periodIsThinFor('M', 5)).toBe(false);
    expect(periodIsThinFor('W', 1)).toBe(true);
    expect(periodIsThinFor('W', 3)).toBe(false);
    expect(periodIsThinFor('D', 1)).toBe(false);
    expect(periodIsThinFor('M', null)).toBe(false);
  });
});
