import { describe, it, expect } from 'vitest';
import { countActiveUniverse, universeSummary } from './universeFilter';

describe('countActiveUniverse', () => {
  it('빈 universe → 0', () => expect(countActiveUniverse({})).toBe(0));
  it('활성 축마다 +1', () =>
    expect(countActiveUniverse({ markets: ['KOSPI'], exclude_etf: true })).toBe(2));
  it('시장 양쪽 선택도 1로 센다 (단순 규칙)', () =>
    expect(countActiveUniverse({ markets: ['KOSPI', 'KOSDAQ'] })).toBe(1));
  it('세 축 모두 → 3', () =>
    expect(countActiveUniverse({ markets: ['KOSPI'], exclude_etf: true, exclude_halted: true })).toBe(3));
});

describe('universeSummary', () => {
  it('빈 universe → ""', () => expect(universeSummary({})).toBe(''));
  it('활성 항목을 읽기 순서로 나열', () =>
    expect(universeSummary({ markets: ['KOSPI'], exclude_etf: true })).toBe('KOSPI · ETF 제외'));
  it('복수 시장은 · 로 결합', () =>
    expect(universeSummary({ markets: ['KOSPI', 'KOSDAQ'], exclude_halted: true })).toBe('KOSPI·KOSDAQ · 거래정지 제외'));
});
