import { describe, expect, it } from 'vitest';

import { buildInvestorDailyTable, INVESTOR_COLUMNS } from './investorDailyRows';
import type { InvestorNetPoint, InvestorSubjectBreakdown } from '../api/types';

/** 실측 행(005930 · 20260803 · ka10059 · 주). 백엔드 `ROW_59` 와 같은 응답이다. */
const MEASURED: InvestorSubjectBreakdown = {
  individual: 8_658_155,
  native_foreign: 27_186,
  other_corp: 278_288,
  fin_invest: -3_563_890,
  insurance: 51_236,
  trust: -1_292_721,
  other_fin: 8_289,
  bank: 6_344,
  pension: -129_133,
  private_fund: -120_079,
  nation: 0,
};

const anchor = (yyyymmdd: string) =>
  Date.parse(
    `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6)}T09:00:00+09:00`,
  );

const point = (
  date: string,
  overrides: Partial<InvestorNetPoint> = {},
): InvestorNetPoint => ({
  t_ms: anchor(date),
  // 외국인은 내외국인이 **이미 합산된** 값이다(KIS 정의) — -3,923,675 + 27,186.
  foreign_net: -3_896_489,
  institution_net: -5_039_954,
  breakdown: MEASURED,
  ...overrides,
});

describe('buildInvestorDailyTable', () => {
  it('실측 행의 항등식 둘을 그대로 통과시킨다', () => {
    const { rows } = buildInvestorDailyTable([point('20260803')], 20);
    const v = rows[0].values;

    // ① 상위 4주체 합 == 0. 내외국인은 foreign 에 접혀 있으므로 따로 더하지 않는다 —
    //    더하면 이중 계상이라 이 단언이 27,186 만큼 어긋난다.
    expect(v.individual! + v.foreign! + v.institution! + v.other_corp!).toBe(0);

    // ② 기관 세부 8종 합 == 기관계. "잔차/기타" 컬럼이 필요 없는 근거다.
    const orgnSum = INVESTOR_COLUMNS
      .filter((c) => c.group === 'orgn')
      .reduce((sum, c) => sum + (v[c.key] ?? 0), 0);
    expect(orgnSum).toBe(v.institution);
  });

  it('달력일이 아니라 거래일 수로 자르고 최신을 위에 둔다', () => {
    const points = ['20260731', '20260803', '20260804', '20260805'].map((d) => point(d));
    const { rows } = buildInvestorDailyTable(points, 2);

    expect(rows.map((r) => r.date)).toEqual(['20260805', '20260804']);
  });

  it('입력 순서가 뒤섞여도 최신 구간을 고른다', () => {
    // 벤더 walk 는 커서 방향이라 배열이 늘 오름차순이라는 보장이 없다.
    const points = ['20260805', '20260731', '20260804'].map((d) => point(d));
    const { rows } = buildInvestorDailyTable(points, 2);

    expect(rows.map((r) => r.date)).toEqual(['20260805', '20260804']);
  });

  it('누적은 표시 구간만 더한다 — 잘려 나간 날은 합계에도 없다', () => {
    const points = ['20260803', '20260804', '20260805'].map((d) => point(d));
    const { totals } = buildInvestorDailyTable(points, 2);

    expect(totals.individual).toBe(MEASURED.individual * 2);
    expect(totals.trust).toBe(MEASURED.trust * 2);
  });

  it('분해가 없는 행은 0 이 아니라 null 이고, 합계에서 빠진 사실을 센다', () => {
    // 옛 응답을 든 웜 캐시(ADR-0048: 메모리 전용 · 재기동이 유일한 무효화).
    const stale = point('20260804', { breakdown: null });
    const { rows, totals, missingBreakdown } = buildInvestorDailyTable(
      [point('20260803'), stale],
      20,
    );

    // 0 으로 그리면 "그날 개인 순매수 0" 이라는 거짓말이 된다.
    expect(rows[0].values.individual).toBeNull();
    // 최상위 둘은 분해와 무관하게 살아남는다 — 표의 뼈대가 남는다.
    expect(rows[0].values.foreign).toBe(-3_896_489);
    expect(rows[0].values.institution).toBe(-5_039_954);

    expect(missingBreakdown).toBe(1);
    expect(totals.individual).toBe(MEASURED.individual); // 한 날만 더해졌다
    expect(totals.foreign).toBe(-3_896_489 * 2);
  });

  it('breakdown 키가 아예 없는 옛 payload 도 null 로 읽는다', () => {
    const legacy = { t_ms: anchor('20260803'), foreign_net: -1, institution_net: -2 };
    const { rows, missingBreakdown } = buildInvestorDailyTable([legacy], 20);

    expect(rows[0].values.individual).toBeNull();
    expect(missingBreakdown).toBe(1);
  });

  it('포인트가 없으면 빈 표와 null 합계를 준다', () => {
    const { rows, totals, missingBreakdown } = buildInvestorDailyTable([], 20);

    expect(rows).toEqual([]);
    expect(totals.individual).toBeNull();
    expect(missingBreakdown).toBe(0);
  });
});
