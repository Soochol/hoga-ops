/** 「시장 폭」 4축 계산 — 분모가 죽는 경우와 부재의 종류를 고정한다. */
import { describe, expect, it } from 'vitest';
import type { MarketIndexRow, MarketSectorRow } from '../api/market';
import {
  adrToGauge,
  advanceDeclineRatio,
  advancePct,
  eokToJo,
  highLowIndex,
  risingSectorCount,
  sectorSpread,
  sizeShares,
} from './breadthMath';

function idx(p: Partial<MarketIndexRow>): MarketIndexRow {
  return {
    code: '001', name: '종합', value: 1, change_pct: 1,
    rising: null, falling: null, flat: null, upper: null, lower: null,
    trade_value_eok: null, listed_count: null,
    ...p,
  } as MarketIndexRow;
}
function sec(name: string, change_pct: number | null, trade_value_eok: number | null = null): MarketSectorRow {
  return { code: name, name, value: 1, change_pct, trade_value_eok };
}

describe('advancePct', () => {
  it('보합을 분모에 넣는다 (실측 코스피 675/197/43 → 73.77%, 화면 표기 74)', () => {
    expect(advancePct(idx({ rising: 675, falling: 197, flat: 43 }))).toBeCloseTo(73.77, 2);
    // 보합을 빼면 77.4% 로 3.6%p 부풀려진다 — 분모 선택이 곧 지표 정의다.
    expect(advancePct(idx({ rising: 675, falling: 197, flat: 0 }))).toBeCloseTo(77.41, 2);
  });

  it('값이 없으면 0 이 아니라 null — 0% 는 "전 종목 하락" 이라는 거짓말이다', () => {
    expect(advancePct(null)).toBeNull();
    expect(advancePct(idx({ rising: 10 }))).toBeNull(); // falling 이 없다
  });
});

describe('advanceDeclineRatio', () => {
  it('하락이 0 이면 분모가 죽으므로 null (Infinity 를 그리지 않는다)', () => {
    expect(advanceDeclineRatio(idx({ rising: 100, falling: 0 }))).toBeNull();
  });

  it('실측 코스피 675/197 = 3.43배', () => {
    expect(advanceDeclineRatio(idx({ rising: 675, falling: 197 }))).toBeCloseTo(3.43, 2);
  });
});

describe('adrToGauge (2배 = 50 로그 매핑)', () => {
  it('1배(중립)가 정확히 50', () => {
    expect(adrToGauge(1)).toBeCloseTo(50, 5);
  });

  it('2배는 75, 0.5배는 25 — 상하 대칭', () => {
    expect(adrToGauge(2)).toBeCloseTo(75, 5);
    expect(adrToGauge(0.5)).toBeCloseTo(25, 5);
  });

  it('4배 이상은 100 에서 포화한다 (극단은 눈금이 더 필요 없다)', () => {
    expect(adrToGauge(4)).toBe(100);
    expect(adrToGauge(50)).toBe(100);
  });

  it('null·0·음수는 null', () => {
    expect(adrToGauge(null)).toBeNull();
    expect(adrToGauge(0)).toBeNull();
  });
});

describe('highLowIndex', () => {
  it('실측 코스피 49/(49+20) = 71', () => {
    expect(highLowIndex(49, 20)).toBeCloseTo(71.0, 0);
  });

  it('둘 다 0 이면 분모가 없어 null — 50(중립)으로 채우지 않는다', () => {
    expect(highLowIndex(0, 0)).toBeNull();
  });

  it('신저가 0 이면 100 이 맞다 — 표본이 얇은 건 hint 가 말할 몫', () => {
    expect(highLowIndex(5, 0)).toBe(100);
  });
});

describe('sectorSpread', () => {
  const sectors = [
    sec('음식료/담배', -4.27), sec('화학', 0.76), sec('금속', 2.64), sec('기계/장비', 6.16),
    // 규모별 행은 업종이 아니다 — 섞이면 이중 계산이 된다.
    sec('대형주', 3.87), sec('중형주', 2.76), sec('소형주', 1.72),
  ];

  it('규모별 행을 제외하고 센다', () => {
    const s = sectorSpread(sectors)!;
    expect(s.pcts).toHaveLength(4);
    expect(s.min).toBe(-4.27);
    expect(s.max).toBe(6.16);
    expect(s.range).toBeCloseTo(10.43, 2);
  });

  it('표준편차는 모표준편차 — 이상치 하나짜리 스프레드와 균등한 퍼짐을 가른다', () => {
    const tight = sectorSpread([sec('a', 1), sec('b', 1), sec('c', 1), sec('d', 1)])!;
    expect(tight.range).toBe(0);
    expect(tight.sd).toBe(0);
  });

  it('업종이 2개 미만이면 퍼짐이 정의되지 않는다', () => {
    expect(sectorSpread([sec('a', 1)])).toBeNull();
    expect(sectorSpread([sec('a', null), sec('b', null)])).toBeNull();
  });
});

describe('risingSectorCount', () => {
  it('규모별 행 제외 · 0% 는 상승이 아니다', () => {
    expect(risingSectorCount([sec('a', 1.5), sec('b', 0), sec('c', -1), sec('대형주', 3)])).toEqual([1, 3]);
  });
});

describe('sizeShares', () => {
  const kospi = [sec('대형주', 3.87, 213558), sec('중형주', 2.76, 25040), sec('소형주', 1.72, 12147)];

  it('실측 코스피 — 대형주 83%', () => {
    const got = sizeShares(kospi, 256577);
    expect(got.map((s) => s.name)).toEqual(['대형주', '중형주', '소형주']);
    expect(got[0].share).toBeCloseTo(83.2, 1);
  });

  it('합이 100% 에 못 미치는 것이 정상 — 규모별 지수 밖 종목이 있다', () => {
    const sum = sizeShares(kospi, 256577).reduce((a, s) => a + s.share, 0);
    expect(sum).toBeGreaterThan(95);
    expect(sum).toBeLessThan(100);
  });

  it('코스닥은 규모별 지수가 없어 빈 배열 — 0% 세 조각을 그리지 않는다', () => {
    expect(sizeShares([sec('일반서비스', 1.61, 100)], 63800)).toEqual([]);
  });

  it('분모가 없으면 계산하지 않는다', () => {
    expect(sizeShares(kospi, null)).toEqual([]);
    expect(sizeShares(kospi, 0)).toEqual([]);
  });
});

describe('eokToJo', () => {
  it('실측 코스피 256,577억 = 25.66조', () => {
    expect(eokToJo(256577)).toBeCloseTo(25.66, 2);
  });

  it('null 을 0 으로 채우지 않는다', () => {
    expect(eokToJo(null)).toBeNull();
  });
});
