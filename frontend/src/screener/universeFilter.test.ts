import { describe, it, expect } from 'vitest';
import { countActiveUniverse, isEtfIncluded, universeSummary } from './universeFilter';

/**
 * ⚠ **ETF 축의 의미가 2026-08-23 에 뒤집혔다.**
 *
 * 백엔드 기본이 `exclude_etf: true`(제외)가 되면서, 배지·요약이 말해야 할 것은
 * 「제외했다」가 아니라 **「포함시켰다」**가 됐다 — 기본은 말할 것이 없고 일탈이
 * 말할 것이다. 그래서 아래 케이스들은 `exclude_etf: false` 를 활성으로 센다.
 *
 * **키 부재는 기본(제외)이다.** 프론트가 언체크를 `undefined` 로 접던 규약이 같은 날
 * 걷혔으므로(`UniverseFilterModal`), 이제 부재는 「사용자가 안 건드림」만 뜻한다.
 */
describe('isEtfIncluded', () => {
  it('키 부재 = 기본(제외) → 포함 아님', () => expect(isEtfIncluded({})).toBe(false));
  it('true = 제외 → 포함 아님', () => expect(isEtfIncluded({ exclude_etf: true })).toBe(false));
  it('false = 명시적 포함', () => expect(isEtfIncluded({ exclude_etf: false })).toBe(true));
});

describe('countActiveUniverse', () => {
  it('빈 universe → 0', () => expect(countActiveUniverse({})).toBe(0));
  it('기본값(제외)은 축으로 안 센다 — 말할 것이 없다', () =>
    expect(countActiveUniverse({ exclude_etf: true })).toBe(0));
  it('활성 축마다 +1 (ETF 는 **포함**이 활성)', () =>
    expect(countActiveUniverse({ markets: ['KOSPI'], exclude_etf: false })).toBe(2));
  it('시장 양쪽 선택도 1로 센다 (단순 규칙)', () =>
    expect(countActiveUniverse({ markets: ['KOSPI', 'KOSDAQ'] })).toBe(1));
  it('세 축 모두 → 3', () =>
    expect(countActiveUniverse({ markets: ['KOSPI'], exclude_etf: false, exclude_halted: true })).toBe(3));
});

describe('universeSummary', () => {
  it('빈 universe → ""', () => expect(universeSummary({})).toBe(''));
  it('기본값(제외)은 표기하지 않는다', () =>
    expect(universeSummary({ exclude_etf: true })).toBe(''));
  it('활성 항목을 읽기 순서로 나열', () =>
    expect(universeSummary({ markets: ['KOSPI'], exclude_etf: false })).toBe('KOSPI · ETF 포함'));
  it('복수 시장은 · 로 결합', () =>
    expect(universeSummary({ markets: ['KOSPI', 'KOSDAQ'], exclude_halted: true })).toBe('KOSPI·KOSDAQ · 거래정지 제외'));
});
